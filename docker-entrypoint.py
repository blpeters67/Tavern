"""Container entrypoint.

Starts as root just long enough to make sure the data folder belongs to the
`tavern` user (Docker creates a fresh ./data bind mount owned by root) and to
refresh yt-dlp, then drops privileges and runs the given command.
"""

import os
import pwd
import subprocess
import sys


def chown_tree(path: str, uid: int, gid: int) -> None:
    os.lchown(path, uid, gid)
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            os.lchown(os.path.join(root, name), uid, gid)


def update_ytdlp() -> None:
    """Sites like YouTube change often; a fresh yt-dlp keeps link imports working."""
    if os.environ.get("YTDLP_AUTO_UPDATE", "true").strip().lower() in ("0", "false", "no", "off"):
        return
    if os.environ.get("JUKEBOX_URL_IMPORTS", "true").strip().lower() in ("0", "false", "no", "off"):
        return
    print("Checking for a newer yt-dlp...", flush=True)
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--no-cache-dir", "--disable-pip-version-check", "--upgrade", "yt-dlp[default]"],
            check=True,
            timeout=120,
        )
    except Exception as exc:  # offline, PyPI down... the installed copy still works
        print(f"Couldn't update yt-dlp ({exc}); using the installed version.", flush=True)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: docker-entrypoint.py COMMAND [ARGS...]")

    if os.getuid() == 0:
        update_ytdlp()
        user = pwd.getpwnam("tavern")
        data = os.environ.get("TAVERN_DATA_DIR", "/data")
        os.makedirs(data, exist_ok=True)
        if os.stat(data).st_uid != user.pw_uid:
            print(f"Giving {data} to the tavern user...", flush=True)
            chown_tree(data, user.pw_uid, user.pw_gid)
        os.setgroups([])
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
        os.environ["HOME"] = user.pw_dir
        os.environ["USER"] = user.pw_name

    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
