import { cookies } from "next/headers";
import { getDict, LANG_COOKIE, type Lang } from "./index";

export async function getLang(): Promise<Lang> {
	const store = await cookies();
	const value = store.get(LANG_COOKIE)?.value;
	return value === "sw" ? "sw" : "en";
}

export async function getServerDict() {
	const lang = await getLang();
	return { lang, t: getDict(lang) };
}
