//! Container start (SEC-05): what `deploy/docker-entrypoint.sh` did up to 1.1.0, so the image needs no shell.
//!
//! - The web app never runs as root.
//! - `--init-unraid-data` (Unraid template, `PostArgs`): as root, prepare the bind mount at `/data` for UID 10001,
//!   then drop to that user for good, like `setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs
//!   --inh-caps=-all --ambient-caps=-all --bounding-set=-all`.
//! - `--health` as root (the Unraid healthcheck runs as the container user root): drop first, then check.
//! - `--setup-code` and `--reset-owner` run as any user, like `docker exec` up to 1.1.0.
//!
//! Capabilities and `no_new_privs` are per thread, so [`prepare`] runs in the synchronous `main` before the Tokio
//! runtime starts any thread.
use std::{
    ffi::OsStr,
    fs::{self, File, Permissions},
    io,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt, chown, fchown},
    },
    path::Path,
};

/// UID and GID of the service in the image.
pub const APP_ID: u32 = 10001;
/// The only data directory the Unraid initialization prepares.
const DATA: &str = "/data";
/// Files of the data directory the initialization hands over to [`APP_ID`].
const DATA_FILES: [&str; 6] = [
    "keyhunter.db",
    "keyhunter.db-wal",
    "keyhunter.db-shm",
    "keyhunter.db-journal",
    "bootstrap-token",
    "igdb-credentials.json",
];

/// Checks the start mode and the user, prepares the Unraid data directory and drops privileges where needed. Removes
/// `--init-unraid-data` from `args`. The error is the message for stderr; the caller exits with 1.
pub fn prepare(args: &mut Vec<String>) -> Result<(), String> {
    let root = unsafe { libc::geteuid() } == 0;
    match args.first().map(String::as_str) {
        Some("--health") if root => drop_privileges(),
        // `--setup-code` only reads the code file. `--reset-owner` refuses any user but the owner of the data
        // directory itself, with a hint for Unraid (`docker exec` runs as root there).
        Some("--health" | "--setup-code" | "--reset-owner") => Ok(()),
        Some("--init-unraid-data") => {
            args.remove(0);
            if !root {
                return Err("data initialization requires the current Unraid template".into());
            }
            init_data()?;
            drop_privileges()
        }
        _ if root => Err("refusing to run the web app as root".into()),
        _ => Ok(()),
    }
}

/// Hands the bind mount at `/data` and the known data files to [`APP_ID`].
fn init_data() -> Result<(), String> {
    if std::env::var_os("KEYHUNTER_DATA_DIR").is_some_and(|dir| !dir.is_empty() && dir != DATA) {
        return Err("Unraid data initialization requires KEYHUNTER_DATA_DIR=/data".into());
    }
    let data = Path::new(DATA);
    let mountinfo = fs::read("/proc/self/mountinfo").unwrap_or_default();
    let is_link = data
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink());
    if is_link || !is_mount_point(&mountinfo, data) {
        return Err("attach a dedicated writable mount at /data".into());
    }
    check_data_files(data)?;
    fs::metadata(data)
        .and_then(|m| {
            let mode = (m.permissions().mode() | 0o700) & !0o022 & 0o7777;
            fs::set_permissions(data, Permissions::from_mode(mode))
        })
        .map_err(|_| "cannot set owner permissions on /data; check the data mount and template")?;
    for name in DATA_FILES {
        prepare_file(&data.join(name)).map_err(|_| format!("cannot prepare {name}"))?;
    }
    chown(data, Some(APP_ID), Some(APP_ID))
        .map_err(|_| "cannot set ownership on /data; check the data mount and template".into())
}

/// Whether `path` is the mount point (field 5) of a line of `/proc/self/mountinfo`; this also finds bind mounts of
/// a directory on the same file system. Spaces, tabs, newlines and backslashes there are octal escapes (`\040`).
fn is_mount_point(mountinfo: &[u8], path: &Path) -> bool {
    mountinfo
        .split(|&b| b == b'\n')
        .filter_map(|line| line.split(|&b| b == b' ').nth(4))
        .any(|field| Path::new(OsStr::from_bytes(&unescape(field))) == path)
}

fn unescape(field: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(field.len());
    let mut i = 0;
    while i < field.len() {
        let octal = field
            .get(i + 1..i + 4)
            .filter(|digits| field[i] == b'\\' && digits.iter().all(|d| (b'0'..=b'7').contains(d)));
        match octal {
            Some(digits) => {
                let value = digits.iter().fold(0u32, |v, d| v * 8 + u32::from(d - b'0'));
                out.push(value as u8);
                i += 4;
            }
            None => {
                out.push(field[i]);
                i += 1;
            }
        }
    }
    out
}

/// Every known data file that exists is a regular file with one link: no symlink or hardlink makes the
/// initialization change a file outside the data directory.
fn check_data_files(dir: &Path) -> Result<(), String> {
    for name in DATA_FILES {
        let Ok(meta) = dir.join(name).symlink_metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            return Err(format!("cannot initialize a symbolic link: {name}"));
        }
        if !meta.is_file() || meta.nlink() != 1 {
            return Err(format!("expected a regular, singly linked file: {name}"));
        }
    }
    Ok(())
}

/// 0600 and owner [`APP_ID`] for one data file, through a handle opened without following a symlink.
fn prepare_file(path: &Path) -> io::Result<()> {
    let file = match File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        file => file?,
    };
    if !file.metadata()?.is_file() {
        return Ok(());
    }
    file.set_permissions(Permissions::from_mode(0o600))?;
    fchown(&file, Some(APP_ID), Some(APP_ID))
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: libc::c_int,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

/// `_LINUX_CAPABILITY_VERSION_3`: two 32-bit words per set.
const CAP_VERSION_3: u32 = 0x2008_0522;

fn capabilities() -> io::Result<[CapData; 2]> {
    let mut header = CapHeader {
        version: CAP_VERSION_3,
        pid: 0,
    };
    let mut data = [CapData::default(); 2];
    let result = unsafe { libc::syscall(libc::SYS_capget, &mut header, data.as_mut_ptr()) };
    if result == 0 {
        Ok(data)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `prctl` with one argument; the unused ones must be 0, passed at full width through the variadic call.
unsafe fn prctl(option: libc::c_int, arg: libc::c_ulong) -> libc::c_int {
    const NONE: libc::c_ulong = 0;
    unsafe { libc::prctl(option, arg, NONE, NONE, NONE) }
}

/// Becomes [`APP_ID`] for good: no supplementary groups, empty bounding, ambient and inheritable capability sets,
/// `no_new_privs`, then real, effective and saved GID and UID. The bounding set needs CAP_SETPCAP, so it goes before
/// the UID change, which clears the permitted and effective sets. Fails unless the process ends up as [`APP_ID`]
/// without any capability.
fn drop_privileges() -> Result<(), String> {
    fn check(step: &str, ok: bool) -> Result<(), String> {
        if ok {
            Ok(())
        } else {
            Err(format!(
                "cannot drop privileges ({step}): {}",
                io::Error::last_os_error()
            ))
        }
    }
    // SAFETY: plain system calls on the current, still single-threaded process; `capset` gets a valid header and
    // two data words, as `_LINUX_CAPABILITY_VERSION_3` requires.
    unsafe {
        check("groups", libc::setgroups(0, std::ptr::null()) == 0)?;
        for cap in 0.. {
            match prctl(libc::PR_CAPBSET_READ, cap) {
                1 => check("bounding set", prctl(libc::PR_CAPBSET_DROP, cap) == 0)?,
                0 => {}
                _ => break,
            }
        }
        check(
            "ambient capabilities",
            prctl(
                libc::PR_CAP_AMBIENT,
                libc::PR_CAP_AMBIENT_CLEAR_ALL as libc::c_ulong,
            ) == 0,
        )?;
        let mut sets = capabilities().map_err(|e| format!("cannot drop privileges: {e}"))?;
        for set in &mut sets {
            set.inheritable = 0;
        }
        let mut header = CapHeader {
            version: CAP_VERSION_3,
            pid: 0,
        };
        check(
            "inheritable capabilities",
            libc::syscall(libc::SYS_capset, &mut header, sets.as_ptr()) == 0,
        )?;
        check("no_new_privs", prctl(libc::PR_SET_NO_NEW_PRIVS, 1) == 0)?;
        check("gid", libc::setresgid(APP_ID, APP_ID, APP_ID) == 0)?;
        check("uid", libc::setresuid(APP_ID, APP_ID, APP_ID) == 0)?;

        let (mut r, mut e, mut s) = (0, 0, 0);
        let uid = libc::getresuid(&mut r, &mut e, &mut s) == 0 && [r, e, s] == [APP_ID; 3];
        let gid = libc::getresgid(&mut r, &mut e, &mut s) == 0 && [r, e, s] == [APP_ID; 3];
        let groups = libc::getgroups(0, std::ptr::null_mut()) == 0;
        let caps = capabilities().is_ok_and(|sets| {
            sets.iter()
                .all(|set| set.effective == 0 && set.permitted == 0 && set.inheritable == 0)
        });
        if !(uid && gid && groups && caps) {
            return Err(format!(
                "still privileged after dropping to UID {APP_ID}; refusing to start"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    const MOUNTINFO: &[u8] = b"\
2210 1998 0:211 / / ro,relatime master:1 - overlay overlay rw,lowerdir=/l
2211 2210 0:214 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
2245 2210 259:2 /home/user/app\\040data/kh /data rw,relatime - ext4 /dev/nvme0n1p2 rw
2246 2210 259:2 /cfg /my\\040config\\011dir rw,relatime - ext4 /dev/nvme0n1p2 rw
2247 2210 259:2 /x /back\\134slash rw,relatime - ext4 /dev/nvme0n1p2 rw
";

    #[test]
    fn mountinfo_finds_bind_mounts_by_their_mount_point() {
        assert!(is_mount_point(MOUNTINFO, Path::new("/data")));
        assert!(is_mount_point(MOUNTINFO, Path::new("/")));
        // The source path inside the file system (field 4) is no mount point.
        assert!(!is_mount_point(
            MOUNTINFO,
            Path::new("/home/user/app data/kh")
        ));
        assert!(!is_mount_point(MOUNTINFO, Path::new("/data/sub")));
        assert!(!is_mount_point(MOUNTINFO, Path::new("/dat")));
        assert!(!is_mount_point(b"", Path::new("/data")));
    }

    #[test]
    fn mountinfo_octal_escapes_are_decoded() {
        assert!(is_mount_point(MOUNTINFO, Path::new("/my config\tdir")));
        assert!(is_mount_point(MOUNTINFO, Path::new("/back\\slash")));
        assert!(!is_mount_point(
            MOUNTINFO,
            Path::new("/my\\040config\\011dir")
        ));
        assert_eq!(unescape(b"a\\040b\\134\\9x\\04"), b"a b\\\\9x\\04");
    }

    #[test]
    fn data_files_must_be_regular_and_singly_linked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        // Missing files and unrelated files are fine.
        assert_eq!(check_data_files(path), Ok(()));
        fs::write(path.join("keyhunter.db"), b"db").unwrap();
        fs::write(path.join("unrelated"), b"x").unwrap();
        fs::hard_link(path.join("unrelated"), path.join("unrelated-link")).unwrap();
        assert_eq!(check_data_files(path), Ok(()));

        symlink("/etc/passwd", path.join("bootstrap-token")).unwrap();
        assert_eq!(
            check_data_files(path),
            Err("cannot initialize a symbolic link: bootstrap-token".into())
        );
        fs::remove_file(path.join("bootstrap-token")).unwrap();
        // A dangling symlink is refused as well.
        symlink(path.join("missing"), path.join("keyhunter.db-wal")).unwrap();
        assert_eq!(
            check_data_files(path),
            Err("cannot initialize a symbolic link: keyhunter.db-wal".into())
        );
        fs::remove_file(path.join("keyhunter.db-wal")).unwrap();

        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::hard_link(outside.path(), path.join("igdb-credentials.json")).unwrap();
        assert_eq!(
            check_data_files(path),
            Err("expected a regular, singly linked file: igdb-credentials.json".into())
        );
        fs::remove_file(path.join("igdb-credentials.json")).unwrap();

        fs::create_dir(path.join("keyhunter.db-shm")).unwrap();
        assert_eq!(
            check_data_files(path),
            Err("expected a regular, singly linked file: keyhunter.db-shm".into())
        );
    }

    #[test]
    fn preparing_a_file_never_follows_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        fs::write(&target, b"x").unwrap();
        fs::set_permissions(&target, Permissions::from_mode(0o644)).unwrap();
        symlink(&target, dir.path().join("link")).unwrap();
        assert!(prepare_file(&dir.path().join("link")).is_err());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
        // A missing file is nothing to do.
        assert!(prepare_file(&dir.path().join("missing")).is_ok());
    }

    #[test]
    fn the_web_app_refuses_root_and_init_needs_root() {
        let root = unsafe { libc::geteuid() } == 0;
        for command in ["--setup-code", "--reset-owner"] {
            assert_eq!(prepare(&mut vec![command.into()]), Ok(()));
        }
        if root {
            for mut args in [vec![], vec!["--canary".into()]] {
                assert_eq!(
                    prepare(&mut args),
                    Err("refusing to run the web app as root".into())
                );
            }
        } else {
            assert_eq!(prepare(&mut vec![]), Ok(()));
            let mut args = vec!["--init-unraid-data".to_string(), "--reset-owner".into()];
            assert_eq!(
                prepare(&mut args),
                Err("data initialization requires the current Unraid template".into())
            );
            assert_eq!(args, ["--reset-owner"]);
        }
    }
}
