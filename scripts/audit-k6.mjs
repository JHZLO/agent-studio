import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const tools = resolve(import.meta.dirname, "../.local/tools"), goRoot = join(tools, "go1.27.3");
const env = { PATH: `${join(goRoot, "bin")}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GOBIN: tools, GOPATH: join(tools, "go-cache"), GOCACHE: join(tools, "go-build"), GOENV: "off", GOTOOLCHAIN: "local", GOPROXY: "https://proxy.golang.org", GOSUMDB: "sum.golang.org", GOMAXPROCS: "4" };
execFileSync(join(goRoot, "bin/go"), ["install", "golang.org/x/vuln/cmd/govulncheck@v1.9.0"], { env, stdio: "inherit", timeout: 300000 });
execFileSync(join(tools, "govulncheck"), ["-mode=binary", join(tools, "k6")], { env, stdio: "inherit", timeout: 120000 });
