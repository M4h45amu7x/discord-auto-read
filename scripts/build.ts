import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_META } from "../src/meta";

const metadataHeader = `/**
 * @name ${PLUGIN_META.name}
 * @version ${PLUGIN_META.version}
 * @description ${PLUGIN_META.description}
 * @author ${PLUGIN_META.author}
 * @authorLink ${PLUGIN_META.authorLink}
 * @website ${PLUGIN_META.website}
 * @source ${PLUGIN_META.source}
 */`;

const temporaryDirectory = await mkdtemp(join(tmpdir(), "discord-auto-read-"));

try {
    const result = await Bun.build({
        entrypoints: ["src/index.ts"],
        outdir: temporaryDirectory,
        target: "node",
        format: "cjs",
        minify: {
            whitespace: true,
            syntax: true,
            identifiers: true,
            keepNames: true,
        },
        sourcemap: "none",
    });

    if (!result.success) {
        throw new Error(result.logs.map((log) => log.message).join("\n"));
    }

    const bundle = result.outputs[0];
    if (!bundle) {
        throw new Error("Build produced no output.");
    }

    const bundleSource = await readFile(bundle.path, "utf8");
    const artifactSource = `${metadataHeader}\n${bundleSource.trim()}\nmodule.exports = module.exports.default;\n`;
    if (!artifactSource.startsWith("/**")) {
        throw new Error("Build output is missing the BetterDiscord metadata header.");
    }

    await Bun.write("dist/SmartAutoRead.plugin.js", artifactSource);
} finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
}
