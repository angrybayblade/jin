import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "jin",
		identifier: "dev.jin.app",
		version: "0.0.1",
		// jin://open?path=/t/PLEN-1 brings the window up there (notifications link here).
		urlSchemes: ["jin"],
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
