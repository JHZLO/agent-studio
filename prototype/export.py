"""Bundle the prototype into one offline HTML file without installing dependencies."""

import base64
import hashlib
from pathlib import Path


def main():
    source = Path(__file__).resolve().parent
    output = source.parent / "dist" / "agent-studio-mockup.html"
    html = (source / "index.html").read_text()
    css = (source / "styles.css").read_text()
    html = html.replace('<link rel="stylesheet" href="styles.css">', f"<style>\n{css}\n</style>")
    scripts = []
    hashes = []
    for name in ["demo-engine.js", "skills.js", "app.js"]:
        html = html.replace(f'<script defer src="{name}"></script>', "")
        contents = "\n" + (source / name).read_text() + "\n"
        digest = base64.b64encode(hashlib.sha256(contents.encode()).digest()).decode()
        hashes.append(f"'sha256-{digest}'")
        scripts.append(f"<script>{contents}</script>")
    html = html.replace("script-src 'self'", "script-src " + " ".join(hashes))
    html = html.replace("connect-src 'self'", "connect-src 'none'")
    html = html.replace('<html lang="en">', '<html lang="en" data-offline="true">')
    html = html.replace("</body>", "\n".join(scripts) + "\n</body>")
    output.parent.mkdir(exist_ok=True)
    output.write_text(html)
    print(output)


if __name__ == "__main__":
    main()
