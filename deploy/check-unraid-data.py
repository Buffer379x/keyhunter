"""Exercise the Unraid template against a new bind mount and a stopped database.

The image has no shell (SEC-05): files in the data directory are changed and inspected with a small pinned helper
image, the process status is read from the host's /proc. The container runs in an internal network: the host reaches
it at its address, it reaches nothing outside (the Eneba worker starts before the test switches the shops off).
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

# Helper with a shell for preparing and inspecting the data directory; update tag and digest together.
HELPER = "busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"

root = Path(__file__).resolve().parents[1]
template = ET.parse(root / "deploy/unraid/keyhunter.xml").getroot()
image = sys.argv[1]
options = shlex.split(template.findtext("ExtraParams"))
post_args = shlex.split(template.findtext("PostArgs"))
test_dir = root / "work/check"
test_dir.mkdir(parents=True, exist_ok=True)


def docker(*args):
    return subprocess.check_output(["docker", *map(str,args)], text=True, stderr=subprocess.STDOUT).strip()


def wait_for(url):
    for _ in range(70):
        try:
            with urlopen(url + "/health/ready", timeout=2) as result:
                if result.status == 200:
                    return
        except (URLError, TimeoutError, OSError):
            time.sleep(0.2)
    raise RuntimeError("Container did not become ready")


def wait_healthy(name):
    for _ in range(60):
        status = docker("inspect", "-f", "{{.State.Health.Status}}", name)
        if status == "healthy":
            return
        time.sleep(0.5)
    raise RuntimeError(f"Healthcheck status {status}")


def refused(args, message, *extra):
    """Runs the image once with `args`; it must exit with 1 and print `message`."""
    result = subprocess.run(["docker", "run", "--rm", "--network", "none", *extra, image, *args],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 1, (args, result.returncode, result.stderr)
    assert result.stderr.strip() == f"KeyHunter: {message}", result.stderr


with tempfile.TemporaryDirectory(prefix="unraid-data-", dir=test_dir) as folder:
    name = Path(folder).name
    data = Path(folder) / "data"
    mount = f"{data}:/data:rw"
    running = False
    network = False
    no_volume = f"keyhunter-no-volume-{os.getpid()}:local"

    def helper(script):
        # Only its output: Docker's own messages on stderr (such as a pull) are no part of the answer.
        return subprocess.run(["docker", "run", "--rm", "--user", "0:0", "--network", "none", "-v", mount, HELPER,
                               "sh", "-ec", script], check=True, capture_output=True, text=True).stdout.strip()

    def unraid_start(*extra):
        return subprocess.run(["docker", "run", "--rm", "--network", "none", "-v", mount, *options, *extra,
                               image, *post_args], capture_output=True, text=True, timeout=60)

    def address():
        return "http://" + docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name) + ":3000"

    try:
        # A fresh runner has no helper image yet; pull it before the first check.
        docker("pull", "-q", HELPER)
        docker("network", "create", "--internal", name)
        network = True
        docker("run", "-d", "--name", name, "--network", name, "--health-interval", "1s",
               "-v", mount, *options, image, *post_args)
        running = True
        url = address()
        wait_for(url)
        pid = docker("inspect", "-f", "{{.State.Pid}}", name)
        status = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines())
        for field in ("Uid", "Gid"):
            assert status[field].split() == ["10001"]*4, field
        assert status["Groups"].strip() == "", "Groups"
        for field in ("CapInh", "CapEff", "CapPrm", "CapBnd", "CapAmb"):
            assert int(status[field].strip(),16) == 0, field
        assert status["NoNewPrivs"].strip() == "1"
        assert helper("stat -c '%u:%g %a' /data/keyhunter.db") == "10001:10001 600"
        # The healthcheck runs as root here and drops privileges first.
        wait_healthy(name)

        reply = {}
        token = docker("exec", "-u", "10001:10001", name, "/app/keyhunter", "--setup-code")
        assert docker("exec", name, "/app/keyhunter", "--setup-code") == token
        def api(path, method="GET", body=None):
            headers = {"Origin":url, **reply}
            if body is not None:
                headers["Content-Type"] = "application/json"
            req = Request(url+"/api/v1"+path, None if body is None else json.dumps(body).encode(), headers, method=method)
            with urlopen(req, timeout=8) as response:
                values = json.load(response)
                if response.headers.get("Set-Cookie"):
                    reply["Cookie"] = response.headers["Set-Cookie"].split(";")[0]
                    reply["X-CSRF-Token"] = values["csrf_token"]
                return values

        api("/setup","POST",{"token":token,"password":"synthetic Docker fixture phrase"})
        settings = api("/settings")
        for source in settings["sources"]:
            if source["kind"] == "shop":
                source["enabled"] = False
        api("/settings","PUT",settings)
        api("/wishlist","POST",{"manual_title":"Testspiel","platform_id":169})
        docker("stop",name)
        helper("chown 0:0 /data /data/keyhunter.db; chmod 0700 /data; "
               "touch /data/unrelated; chmod 0644 /data/unrelated")

        # Links that would let the preparation change files outside the data directory stop the start.
        helper("mv /data/bootstrap-token /data/token.saved; ln -s /data/unrelated /data/bootstrap-token")
        result = unraid_start()
        assert result.returncode == 1 and "KeyHunter: cannot initialize a symbolic link: bootstrap-token" in result.stderr, result
        helper("rm /data/bootstrap-token; mv /data/token.saved /data/bootstrap-token; ln /data/keyhunter.db /data/db.hardlink")
        result = unraid_start()
        assert result.returncode == 1 and "KeyHunter: expected a regular, singly linked file: keyhunter.db" in result.stderr, result
        helper("rm /data/db.hardlink")
        assert helper("stat -c '%u:%g %a' /data/unrelated /data/keyhunter.db") == "0:0 644\n0:0 600"

        docker("start",name)
        url = address()
        wait_for(url)
        assert api("/wishlist")[0]["manual_title"] == "Testspiel"
        assert helper("stat -c '%u:%g %a' /data/unrelated") == "0:0 644"
        assert helper("stat -c '%u:%g %a' /data/keyhunter.db") == "10001:10001 600"

        # Without the template's init the web app never runs as root, and the init needs root.
        refused([], "refusing to run the web app as root", "--user", "0:0", "-v", mount)
        refused(["--init-unraid-data"], "data initialization requires the current Unraid template", "-v", mount)
        # /data must be a mount of its own; the image's VOLUME always provides one, so copy the files without it.
        subprocess.run(["docker", "build", "-q", "-t", no_volume, "-"], check=True, stdout=subprocess.DEVNULL,
                       input=f'FROM scratch\nCOPY --from={image} / /\nENTRYPOINT ["/app/keyhunter"]\n', text=True)
        result = subprocess.run(["docker", "run", "--rm", "--network", "none", *options, no_volume, *post_args],
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 1 and result.stderr.strip() == "KeyHunter: attach a dedicated writable mount at /data", result
        print("Unraid template passed fresh installation, capability drop, healthcheck, setup code, refused links "
              "and mounts, and restart with older ownership.")
    except Exception:
        if running:
            print(docker("logs", "--tail", "12", name), file=sys.stderr)
        raise
    finally:
        if running:
            subprocess.run(["docker","stop",name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            docker("rm", name)
        if network:
            docker("network", "rm", name)
        subprocess.run(["docker", "rmi", no_volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if data.exists():
            # Return the disposable directory to its test runner for cleanup.
            helper(f"chown -R {os.getuid()}:{os.getgid()} /data")
