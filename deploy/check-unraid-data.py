"""Exercise the Unraid template against a new bind mount and a stopped database."""
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


with tempfile.TemporaryDirectory(prefix="unraid-data-", dir=test_dir) as folder:
    name = Path(folder).name
    data = Path(folder) / "data"
    running = False
    try:
        docker("run", "-d", "--name", name, "--publish", "127.0.0.1::3000",
               "-v", f"{data}:/data:rw", *options, image, *post_args)
        running = True
        url = "http://" + docker("port", name, "3000/tcp")
        wait_for(url)
        status = dict(line.split(":",1) for line in docker(
            "exec", "-u", "10001:10001", name, "cat", "/proc/1/status").splitlines())
        for field in ("Uid", "Gid"):
            assert status[field].split() == ["10001"]*4, field
        for field in ("CapEff", "CapPrm", "CapBnd", "CapAmb"):
            assert int(status[field].strip(),16) == 0, field
        assert status["NoNewPrivs"].strip() == "1"
        assert docker("exec", name, "stat", "-c", "%u:%g %a", "/data/keyhunter.db") == "10001:10001 600"

        reply = {}
        token = docker("exec", "-u", "10001:10001", name, "cat", "/data/bootstrap-token")
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
        docker("run","--rm","--user","0:0","--entrypoint","sh","--network","none",
               "-v",f"{data}:/data:rw",image,"-ec",
               "chown 0:0 /data /data/keyhunter.db; chmod 0700 /data; "
               "touch /data/unrelated; chmod 0644 /data/unrelated")
        docker("start",name)
        url = "http://" + docker("port", name, "3000/tcp")
        wait_for(url)
        assert api("/wishlist")[0]["manual_title"] == "Testspiel"
        assert docker("exec",name,"stat","-c","%u:%g %a","/data/unrelated") == "0:0 644"
        assert docker("exec",name,"stat","-c","%u:%g %a","/data/keyhunter.db") == "10001:10001 600"
        print("Unraid template passed fresh installation, capability drop, and restart with older ownership.")
    except Exception:
        if running:
            print(docker("logs", "--tail", "12", name), file=sys.stderr)
        raise
    finally:
        if running:
            subprocess.run(["docker","stop",name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            docker("rm", name)
        if data.exists():
            # Return the disposable directory to its test runner for cleanup.
            docker("run","--rm","--user","0:0","--entrypoint","chown","--network","none",
                   "-v",f"{data}:/data:rw",image,f"{os.getuid()}:{os.getgid()}","/data")
