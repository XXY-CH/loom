import { emitKeypressEvents, type Key } from "node:readline";
import type { ServiceTransport } from "./service-controller.js";
import { ServiceWorkbench } from "./service-controller.js";
import { renderServiceWorkbench } from "./service-render.js";

export async function runServiceDashboard(options: {
  client: ServiceTransport;
  once?: boolean;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (!options.once && (!input.isTTY || !output.isTTY))
    throw new Error(
      "Service TUI requires an interactive terminal; use --once for plain output",
    );
  let active = true;
  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    if (!active || drawTimer) return;
    drawTimer = setTimeout(() => {
      drawTimer = undefined;
      if (active)
        output.write(
          `\x1b[H${renderServiceWorkbench(workbench.state, output.columns || 120, output.rows || 32, !process.env.NO_COLOR).replaceAll("\n", "\r\n")}`,
        );
    }, 40);
  };
  const workbench = new ServiceWorkbench(
    options.client,
    options.once ? () => {} : draw,
    options.cwd,
  );
  let exit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const onKey = (text: string, key: Key) => {
    if (key.ctrl && key.name === "c") return exit();
    if (workbench.state.draft !== undefined) {
      if (workbench.state.submitting) return;
      if (key.name === "escape") delete workbench.state.draft;
      else if (key.name === "return") void workbench.submitDraft();
      else if (key.name === "backspace")
        workbench.state.draft = [...workbench.state.draft]
          .slice(0, -1)
          .join("");
      else if (text && !key.ctrl && !key.meta)
        workbench.state.draft =
          `${workbench.state.draft}${text.replace(/[\r\n\t]/g, " ")}`.slice(
            0,
            4096,
          );
      draw();
      return;
    }
    if (key.name === "q") return exit();
    void workbench.key(key.name ?? text).catch(() => {
      workbench.state.notice = "Observation failed · refresh to reconnect";
      draw();
    });
  };
  let entered = false;
  const wasRaw = input.isRaw;
  options.signal?.addEventListener("abort", exit, { once: true });
  try {
    if (options.once) {
      await workbench.refresh();
      output.write(
        `${renderServiceWorkbench(workbench.state, 120, 32, false)}\n`,
      );
      return;
    }
    if (options.signal?.aborted) return;
    entered = true;
    output.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    output.on("resize", draw);
    process.once("SIGINT", exit);
    process.once("SIGTERM", exit);
    workbench.start();
    await exited;
  } finally {
    active = false;
    workbench.stop();
    if (drawTimer) clearTimeout(drawTimer);
    options.signal?.removeEventListener("abort", exit);
    if (entered) {
      input.removeListener("keypress", onKey);
      output.removeListener("resize", draw);
      process.removeListener("SIGINT", exit);
      process.removeListener("SIGTERM", exit);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      output.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    }
  }
}
