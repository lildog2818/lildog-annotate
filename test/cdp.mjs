/**
 * 极简 CDP 客户端：连到隔离测试实例（默认 127.0.0.1:9222），做界面级检查。
 * Node 22 自带 WebSocket，所以这里不需要任何依赖。
 */
export async function connect({ port = 9222, urlIncludes = "obsidian" } = {}) {
	let targets;
	try {
		targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	} catch (error) {
		throw new Error(
			`连不上 ${port} 端口的调试接口（${error.message}）。先跑 npm run test:vault 启动隔离实例。`,
		);
	}
	const page = targets.find((t) => t.type === "page" && t.url.includes(urlIncludes));
	if (!page) throw new Error("调试接口里没有 Obsidian 页面，实例可能还没加载完");

	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("连不上调试 WebSocket")), {
			once: true,
		});
	});

	let nextId = 0;
	const pending = new Map();
	ws.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		message.error
			? reject(new Error(JSON.stringify(message.error)))
			: resolve(message.result);
	});

	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});

	const evaluate = async (expression) => {
		const result = await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (result.exceptionDetails) {
			throw new Error(
				result.exceptionDetails.exception?.description ??
					JSON.stringify(result.exceptionDetails),
			);
		}
		return result.result.value;
	};

	const mouse = (type, x, y, extra = {}) =>
		send("Input.dispatchMouseEvent", {
			type,
			x: Math.round(x),
			y: Math.round(y),
			button: type === "mouseMoved" ? "none" : "left",
			clickCount: type === "mouseMoved" ? 0 : 1,
			...extra,
		});

	/** 先挪过去再按，模拟真实鼠标：悬停逻辑才认 */
	const hover = async (x, y) => {
		await mouse("mouseMoved", x - 40, y);
		await sleep(120);
		await mouse("mouseMoved", x, y);
		await sleep(120);
		await mouse("mouseMoved", x + 1, y);
	};

	const click = async (x, y) => {
		await mouse("mouseMoved", x, y);
		await mouse("mousePressed", x, y);
		await mouse("mouseReleased", x, y);
	};

	const key = async (keyName, { code, keyCode, text, modifiers = 0 } = {}) => {
		const common = {
			key: keyName,
			code: code ?? keyName,
			windowsVirtualKeyCode: keyCode,
			nativeVirtualKeyCode: keyCode,
			modifiers,
		};
		await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
		if (text) await send("Input.dispatchKeyEvent", { type: "char", text, ...common });
		await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
	};

	return {
		send,
		evaluate,
		mouse,
		hover,
		click,
		key,
		type: (text) => send("Input.insertText", { text }),
		close: () => ws.close(),
		browserClose: async () => {
			const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
			const browser = new WebSocket(info.webSocketDebuggerUrl);
			await new Promise((resolve) => browser.addEventListener("open", resolve, { once: true }));
			browser.send(JSON.stringify({ id: 1, method: "Browser.close" }));
			await sleep(1500);
		},
	};
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 检查项收集器：一项不通过不算崩，最后一起报 */
export function createChecker() {
	const results = [];
	return {
		check(name, ok, detail = "") {
			results.push({ name, ok: !!ok, detail });
			console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
		},
		report() {
			const failed = results.filter((item) => !item.ok);
			console.log(
				`\n${failed.length ? "✗" : "✓"} 界面检查 ${results.length - failed.length}/${results.length} 项通过\n`,
			);
			return failed.length === 0;
		},
	};
}
