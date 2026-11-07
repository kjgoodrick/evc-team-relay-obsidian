import type { TFile } from "obsidian";
import { readRetainedTextSource } from "../storage/retained-text-source";
import type { NativeGroupSource, RetainedGroupCandidate } from "./NativeBaseGroupComments";

interface RetainedGroupPort {
	/** Capture identity and a cheap guard. Do not open or construct a document. */
	key(file: TFile): { name: string; current(): boolean } | undefined;
	read(file: TFile): Promise<string>;
}

/** Discover cache names once, then defer all content reads until the caller has
 * authorized the corresponding record. Older hosts fall back to aborting an
 * absent database's first creation in readRetainedTextSource. */
export async function retainedBaseGroupSources(files: TFile[], port: RetainedGroupPort,
	current: () => boolean, factory: IDBFactory = indexedDB): Promise<RetainedGroupCandidate[]> {
	if (!current()) return [];
	const candidates = files.map(file => ({ file, key: port.key(file) })).filter(item => item.key !== undefined);
	let names: Set<string | undefined> | undefined;
	if (typeof factory.databases === "function") {
		let timer: number | undefined;
		try {
			const databases = await Promise.race([
				factory.databases(), new Promise<undefined>(resolve => { timer = window.setTimeout(resolve, 1000); }),
			]);
			if (databases) names = new Set(databases.map(database => database.name));
		} catch { /* Enumeration is optional; the reader never creates a cache. */ }
		finally { window.clearTimeout(timer); }
	}
	if (!current()) return [];
	return candidates.filter(({ key }) => !names || names.has(key!.name)).map(({ file, key }) => ({ file,
		load: async (): Promise<NativeGroupSource | undefined> => {
			const available = () => current() && key!.current();
			if (!available()) return;
			const retained = await readRetainedTextSource(key!.name, { factory, current: available });
			if (!retained) return;
			let transferred = false, released = false;
			const release = () => { if (!released) { released = true; retained.dispose(); } };
			try {
				if (!available() || await port.read(file) !== retained.text.toString() || !available()) return;
				transferred = true;
				return { text: retained.text, current: () => !released && available(), release };
			} finally { if (!transferred) release(); }
		},
	}));
}
