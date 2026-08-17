import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";

const CF = process.env.CF_SRC;
if (!CF) {
	console.error("Set CF_SRC to the Core-Framework checkout root");
	process.exit(1);
}

const WP_SRC = path.join(CF, "packages/wp/src");
const CORE_SRC = path.join(CF, "packages/core/src");

const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function tryResolve(base, spec) {
	const stem = path.join(base, spec);
	if (existsSync(stem) && !EXTS.some((e) => stem.endsWith(e))) {
		// bare dir with index
		for (const e of ["/index.ts", "/index.tsx"]) {
			if (existsSync(stem + e)) return stem + e;
		}
	}
	for (const e of ["", ...EXTS]) {
		const candidate = stem + e;
		if (existsSync(candidate) && candidate.match(/\.(ts|tsx)$/)) return candidate;
	}
	return null;
}

// Mirrors packages/wp/tsconfig.json paths + baseUrl:./src, with the consuming
// package's namespace winning over core's (how the vite/tsc build resolves
// core sources' bare imports like "functions/postcss").
const cfResolver = {
	name: "cf-resolver",
	setup(buildApi) {
		buildApi.onResolve({ filter: /^[^./]/ }, (args) => {
			if (args.path === "cssGenerator") {
				return { path: tryResolve(CORE_SRC, "cssGenerator/index") };
			}
			if (args.path.startsWith("cssGenerator/")) {
				const p = tryResolve(CORE_SRC, args.path);
				if (p) return { path: p };
			}
			if (args.path.startsWith("@core-framework/core/")) {
				const rel = args.path.replace("@core-framework/core/", "");
				const p = tryResolve(CORE_SRC, rel);
				if (p) return { path: p };
			}
			// wp namespace first, then core
			const p = tryResolve(WP_SRC, args.path) || tryResolve(CORE_SRC, args.path);
			if (p) return { path: p };

			return undefined; // fall through to node_modules
		});
	},
};

await build({
	entryPoints: ["entry.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	outfile: "dist/cf-compiler.cjs",
	nodePaths: [path.resolve("node_modules")],
	plugins: [cfResolver],
	define: {
		window: "globalThis",
		"import.meta.env.DEV": "false",
		"import.meta.env": "{}",
	},
	logLevel: "info",
});
