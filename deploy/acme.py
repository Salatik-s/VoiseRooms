"""Public HTTP-01 directory setup, independent of the private upload umask."""

import secrets
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def prepare_webroot(root):
    root = Path(root).absolute()
    if root.resolve() != root:
        raise RuntimeError("ACME webroot must not traverse symbolic links")
    challenge = root / ".well-known" / "acme-challenge"
    for directory in [root, root / ".well-known", challenge]:
        if directory.is_symlink():
            raise RuntimeError("ACME directory must not be a symbolic link")
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        directory.chmod(0o755)
    return challenge


def verify_http_challenge(root, domain, local_origin="http://127.0.0.1"):
    challenge = prepare_webroot(root)
    name = "voicerooms-probe-" + secrets.token_hex(12)
    probe = challenge / name
    payload = ("VoiceRooms HTTP-01 " + secrets.token_hex(24)).encode()
    try:
        with probe.open("xb") as output:
            output.write(payload)
        probe.chmod(0o644)
        path = "/.well-known/acme-challenge/" + name
        for label, origin in [("local Nginx", local_origin), ("public domain", "http://" + domain)]:
            request = Request(origin + path, headers={"Host": domain})
            try:
                with urlopen(request, timeout=15) as response:
                    if response.status != 200 or response.read(4096) != payload:
                        raise RuntimeError("ACME HTTP preflight returned unexpected content at " + label)
            except HTTPError as error:
                raise RuntimeError(
                    "ACME HTTP preflight failed at " + label + " (HTTP " + str(error.code)
                    + "). Certificate request was not sent; inspect Nginx path permissions and routing."
                ) from None
            except (URLError, TimeoutError):
                raise RuntimeError("ACME HTTP preflight could not reach " + label + "; certificate request was not sent") from None
    finally:
        probe.unlink(missing_ok=True)
    print("ACME challenge readable through local Nginx and public HTTP domain")
