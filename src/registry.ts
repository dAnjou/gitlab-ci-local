import execa, {ExecaError} from "execa";
import {Argv} from "./argv.js";
import {Utils} from "./utils.js";
import containerfile from "./Containerfile.registry.txt";

export class Registry {
    readonly prefix: string;
    readonly stateDir: string;
    private readonly cwd: string;
    private readonly containerExecutable: string;
    private _image: string;
    private _network: string | null = null;
    private _dataVolume: string | null = null;
    private _certDirectory: string | null = null;
    private _ipAddress: string | null = null;

    constructor (argv: Argv) {
        this.prefix = "registry.gcl.local";
        this._image = "gitlab-ci-local-registry";
        this.cwd = argv.cwd;
        this.stateDir = `${argv.cwd}/${argv.stateDir}/${this.prefix}`;
        this.containerExecutable = argv.containerExecutable;
    }

    get network () {
        if (!this._network) {
            this._network = `${this.prefix}.net`;
            try {
                Utils.syncSpawn([this.containerExecutable, "network", "create", this._network]);
            } catch (err) {
                if (err instanceof Error && !err.message.includes("already exists"))
                    throw err;
            }
        }
        return this._network;
    }

    get dataVolume () {
        if (!this._dataVolume) {
            this._dataVolume = `${this.prefix}.data`;
            try {
                Utils.syncSpawn([this.containerExecutable, "volume", "create", this._dataVolume]);
            } catch (err) {
                if (err instanceof Error && !err.message.endsWith("already exists"))
                    throw err;
            }
        }
        return this._dataVolume;
    }

    get certDirectory () {
        if (!this._certDirectory) {
            this._certDirectory = `${this.stateDir}/certs`;
            Utils.syncSpawn(["mkdir", "-p", this._certDirectory]);
        }
        return this._certDirectory;
    }

    get ipAddress () {
        if (!this._ipAddress) {
            this._ipAddress = Utils.syncSpawn([
                this.containerExecutable, "inspect", this.prefix,
                "--format", `{{ (index .NetworkSettings.Networks "${this.network}").IPAddress }}`,
            ]).stdout.trim();
        }
        return this._ipAddress;
    }

    get image () {
        try {
            Utils.syncSpawn([this.containerExecutable, "inspect", this._image]);
        } catch {
            execa.sync(
                this.containerExecutable,
                ["build", "--tag", this._image, "--file", "-", this.cwd],
                {input: containerfile},
            );
        }
        return this._image;
    }

    start (): void {
        Utils.syncSpawn([this.containerExecutable, "rm", "--force", this.prefix]);
        Utils.syncSpawn([
            this.containerExecutable, "run", "--detach",
            "--name", this.prefix,
            "--hostname", this.prefix,
            "--network", this.network,
            "--volume", `${this.dataVolume}:/var/lib/registry`,
            "--volume", `${this.certDirectory}:/certs:z`,
            this.image,
        ]);

        try {
            execa.sync(this.containerExecutable, [
                "run", "--rm",
                "--network", this.network,
                "--volume", `${this.certDirectory}:/certs:ro`,
                "--entrypoint", "sh",
                "curlimages/curl",
                "-c", `until [ "$(curl --cacert /certs/ca.crt --write-out '%{http_code}' --silent --out-null https://${this.prefix})" = "200" ]; do sleep 1; done;`,
            ], {
                timeout: 15000,
            });
        } catch (err) {
            this.stop();
            if ((err as ExecaError).timedOut) {
                throw "local docker registry port check timed out";
            }
            throw err;
        }
    }

    pull (image: string): void {
        if (image.startsWith(`${this.prefix}/`)) {
            Utils.syncSpawn([
                "skopeo", "copy", "--src-cert-dir", this.certDirectory,
                `docker://${this.ipAddress}/${image.split("/").slice(1).join("/")}`,
                `docker-daemon:${image}`,
            ]);
        }
    }

    stop (): void {
        Utils.syncSpawn([this.containerExecutable, "rm", "-f", this.prefix]);
    }
}