import { getDict } from "./index";

/**
 * Server-side translator. ATLAS is English-only, so this is a thin wrapper kept
 * so server components have one import path for copy.
 */
export async function getServerDict() {
	return { t: getDict() };
}
