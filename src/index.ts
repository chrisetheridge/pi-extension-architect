import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@mariozechner/pi-tui";
import {
  buildPlanPath,
  buildArchitectEntryReason,
  fallbackArchitectureOptions,
  heuristicClassify,
  normalizeConfig,
  parseArchitectCommandArgs,
  parseArchitectureOptions,
  parseTaskType,
  shouldEnterArchitectMode,
} from "./core.js";
import type {
  ArchitectConfig,
  ArchitectDecision,
  ArchitectureOption,
  SocraticAnswer,
  SocraticQuestion,
  TaskType,
} from "./types.js";
import {
  DEFAULT_PROMPT_TEMPLATES,
  SYSTEM_PROMPTS,
  buildClassifierPrompt,
  buildOptionsPrompt,
  buildReviewPrompt,
  formatAnswers,
  type PromptName,
} from "./prompts.js";
import { buildProgressDots, centerBox, clampContentWidth } from "./ui-format.js";

const execFileAsync = promisify(execFile);

const QUESTIONS: SocraticQuestion[] = [
  {
    id: "problem",
    title: "Problem framing",
    prompt: "What problem are you solving, and what is the user-facing goal?",
  },
  {
    id: "flow",
    title: "Core flow",
    prompt: "What happens step by step in this system?",
  },
  {
    id: "constraints",
    title: "Constraints",
    prompt: "What scale, latency, reliability, security, or compatibility constraints matter?",
  },
  {
    id: "components",
    title: "Components",
    prompt: "What major pieces do you think are involved, and what should each own?",
  },
  {
    id: "risks",
    title: "Risks / unknowns",
    prompt: "Which parts feel unclear, risky, or easy to get wrong?",
  },
  {
    id: "tradeoffs",
    title: "Tradeoffs",
    prompt: "What decisions or tradeoffs do you already see?",
  },
];

const ARCHITECT_MESSAGE_TYPE = "architect-mode";
const LOCKED_TOOLS = new Set(["bash", "edit", "write", "patch", "apply_patch", "python", "node"]);

type QuestionStepResult = { action: "next" | "back"; answer: string } | null;
type ApproachStepResult = "next" | "select" | "custom" | "cancel";
type FreeformStepResult = string | null;

interface RuntimeState {
  disabled: boolean;
  locked: boolean;
  activeDecision?: ArchitectDecision;
}

export default function architectModeExtension(pi: ExtensionAPI): void {
  const state: RuntimeState = {
    disabled: false,
    locked: false,
  };

  pi.registerMessageRenderer("architect-review", (message, _options, theme) => {
    return new ReviewMessageComponent(theme, String(message.content ?? ""));
  });

  pi.registerMessageRenderer("architect-decision", (message, _options, theme) => {
    return new BorderedTextComponent(theme, "Architect Mode", formatMessageBody(String(message.content ?? "")));
  });

  pi.registerCommand("architect", {
    description: "Run Architect Mode or toggle it with disable/enable",
    handler: async (args, ctx) => {
      const action = parseArchitectCommandArgs(args);
      if (action === "disable") {
        disableArchitectMode(pi, ctx, state, "command");
        return;
      }

      if (action === "enable") {
        enableArchitectMode(pi, ctx, state);
        return;
      }

      const prompt = args.trim() || (await ctx.ui.editor("Architect Mode task:", ""))?.trim();
      if (!prompt) {
        ctx.ui.notify("No task provided.", "warning");
        return;
      }
      await runArchitectMode(pi, ctx, state, prompt, "architectural", buildArchitectEntryReason("architectural", "manual"));
    },
  });

  pi.registerCommand("skip-architect", {
    description: "Disable Architect Mode gate for this session",
    handler: async (_args, ctx) => {
      disableArchitectMode(pi, ctx, state, "skip");
    },
  });

  pi.registerCommand("unlock", {
    description: "Unlock implementation tools if Architect Mode is stuck",
    handler: async (_args, ctx) => {
      state.locked = false;
      ctx.ui.setStatus("architect", undefined);
      ctx.ui.setWidget("architect", undefined);
      pi.appendEntry(ARCHITECT_MESSAGE_TYPE, { locked: false, manualUnlock: true });
      ctx.ui.notify("Architect Mode unlocked.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const latest = entries
      .filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === ARCHITECT_MESSAGE_TYPE)
      .pop() as { data?: Partial<RuntimeState> } | undefined;

    state.disabled = latest?.data?.disabled ?? false;
    state.locked = latest?.data?.locked ?? false;
    state.activeDecision = latest?.data?.activeDecision;
    updateStatus(ctx, state);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (state.disabled) return { action: "continue" };
    if (event.text.trim().startsWith("/")) return { action: "continue" };
    if (!ctx.hasUI) return { action: "continue" };

    const cwd = process.cwd();
    showClassifyingStatus(ctx);
    let taskType: TaskType;
    let config: ArchitectConfig;
    try {
      config = await loadConfig(cwd);
      taskType = await classifyTask(ctx, config, event.text, cwd);
    } finally {
      ctx.ui.setStatus("architect", undefined);
    }

    if (!shouldEnterArchitectMode(taskType, config)) {
      ctx.ui.setStatus("architect", undefined);
      return { action: "continue" };
    }

    await runArchitectMode(pi, ctx, state, event.text, taskType, buildArchitectEntryReason(taskType, "automatic"));
    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event) => {
    if (state.disabled) return undefined;
    if (state.locked) {
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n[ARCHITECT MODE LOCKED]\nDo not implement, modify files, run tools, or generate code yet. Ask the user to complete Architect Mode, run /unlock, or run /skip-architect.",
      };
    }

    if (!state.activeDecision) return undefined;

    return {
      message: {
        customType: "architect-context",
        content: buildImplementationContext(state.activeDecision),
        display: false,
      },
    };
  });

  pi.on("tool_call", async (event) => {
    if (state.disabled) return undefined;
    if (!state.locked) return undefined;
    if (!LOCKED_TOOLS.has(event.toolName)) return undefined;

    return {
      block: true,
      reason: "Architect Mode is locked. Complete the architecture flow, or run /unlock or /skip-architect.",
    };
  });
}

async function runArchitectMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  originalPrompt: string,
  taskType: TaskType,
  entryReason: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Architect Mode requires interactive Pi UI.", "error");
    return;
  }

  state.locked = true;
  persist(pi, state, { prompt: originalPrompt, phase: "started" });
  updateStatus(ctx, state, "Collecting design inputs");

  const answers = await collectSocraticAnswers(pi, ctx, state, originalPrompt, entryReason);
  if (!answers) {
    state.locked = false;
    updateStatus(ctx, state);
    persist(pi, state, { prompt: originalPrompt, phase: "cancelled" });
    ctx.ui.notify("Architect Mode cancelled.", "info");
    return;
  }

  const config = await loadConfig(process.cwd());
  const reviewPromptTemplate = await resolvePromptTemplate(ctx, process.cwd(), config, "review");
  const reviewFeedback = await runModelStep(
    ctx,
    config,
    "Reviewing design...",
    buildReviewPrompt({ originalPrompt, answers }, reviewPromptTemplate),
  );

  showReviewWidget(ctx, reviewFeedback);

  const followUpAnswers = await askReviewFollowUp(ctx);
  if (followUpAnswers === null) {
    clearReviewWidget(ctx);
    state.locked = false;
    updateStatus(ctx, state);
    persist(pi, state, { prompt: originalPrompt, phase: "cancelled" });
    ctx.ui.notify("Architect Mode cancelled.", "info");
    return;
  }

  const optionsPromptTemplate = await resolvePromptTemplate(ctx, process.cwd(), config, "options");
  const optionText = await runModelStep(
    ctx,
    config,
    "Generating architecture options...",
    buildOptionsPrompt({ originalPrompt, answers, reviewFeedback, followUpAnswers }, optionsPromptTemplate),
  );
  clearReviewWidget(ctx);
  const options = parseArchitectureOptions(optionText);
  const finalOptions = options.length > 0 ? options : fallbackArchitectureOptions();

  const selected = await chooseApproach(ctx, finalOptions);
  if (!selected) {
    clearReviewWidget(ctx);
    state.locked = false;
    updateStatus(ctx, state);
    persist(pi, state, { prompt: originalPrompt, phase: "cancelled" });
    ctx.ui.notify("Architect Mode cancelled.", "info");
    return;
  }

  const decision: ArchitectDecision = {
    originalPrompt,
    taskType,
    answers,
    reviewFeedback,
    followUpAnswers,
    options: finalOptions,
    selectedApproach: selected.title,
    selectedApproachDetails: selected.details,
    createdAt: new Date().toISOString(),
  };

  const saveConfig = await loadConfig(process.cwd());
  if (saveConfig.savePlans) {
    decision.savedPlanPath = await saveDecisionPlan(process.cwd(), decision);
  }

  state.locked = false;
  state.activeDecision = decision;
  updateStatus(ctx, state, "Unlocked");
  persist(pi, state, { prompt: originalPrompt, phase: "unlocked", activeDecision: decision });

  pi.sendMessage(
    {
      customType: "architect-decision",
      content: `Architect Mode unlocked.\n\nSelected approach: ${decision.selectedApproach}${
        decision.savedPlanPath ? `\nPlan saved: ${decision.savedPlanPath}` : ""
      }`,
      display: true,
    },
    { triggerTurn: false },
  );

  pi.sendUserMessage(buildUnlockedPrompt(decision));
}

async function collectSocraticAnswers(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  originalPrompt: string,
  entryReason: string,
): Promise<SocraticAnswer[] | null> {
  const answers: SocraticAnswer[] = [];
  let index = 0;

  while (index < QUESTIONS.length) {
    const question = QUESTIONS[index];
    if (!question) break;

    updateProgressWidget(ctx, question, index, answers);
    const existing = answers[index]?.answer ?? "";
    const result = await askSocraticQuestion(ctx, question, index, answers, existing, entryReason);
    if (!result) {
      ctx.ui.setWidget("architect", undefined);
      return null;
    }
    if (result.action === "back") {
      index = Math.max(0, index - 1);
      continue;
    }

    const cleaned = stripPromptEcho(result.answer, question.prompt).trim();
    if (!cleaned) {
      ctx.ui.notify("Please add an answer before continuing.", "warning");
      continue;
    }

    answers[index] = {
      questionId: question.id,
      title: question.title,
      prompt: question.prompt,
      answer: cleaned,
    };

    persist(pi, state, { prompt: originalPrompt, phase: "answer", answers });
    index += 1;
  }

  ctx.ui.setWidget("architect", undefined);
  return answers;
}

async function chooseApproach(ctx: ExtensionContext, options: ArchitectureOption[]): Promise<ArchitectureOption | null> {
  for (const option of options) {
    const action = await showApproachCard(ctx, option, options.indexOf(option), options.length);
    if (action === "select") {
      return option;
    }
    if (action === "custom") {
      const custom = await ctx.ui.editor("Define your own approach:", "");
      if (!custom?.trim()) return null;
      return {
        id: "custom",
        title: "Custom approach",
        summary: custom.trim().split("\n")[0] ?? "Custom approach",
        details: custom.trim(),
      };
    }
    if (action === "cancel") {
      return null;
    }
  }

  return chooseApproach(ctx, options);
}

async function askSocraticQuestion(
  ctx: ExtensionContext,
  question: SocraticQuestion,
  index: number,
  answers: SocraticAnswer[],
  existingAnswer: string,
  entryReason: string,
): Promise<QuestionStepResult> {
  return ctx.ui.custom<QuestionStepResult>((tui, theme, _kb, done) => {
    return new QuestionCardComponent({
      tui,
      theme,
      question,
      index,
      total: QUESTIONS.length,
      answeredIndexes: new Set(answers.map((answer, answerIndex) => (answer.answer.trim() ? answerIndex : -1)).filter((i) => i >= 0)),
      initialAnswer: existingAnswer,
      entryReason,
      done,
    });
  });
}

async function showApproachCard(
  ctx: ExtensionContext,
  option: ArchitectureOption,
  index: number,
  total: number,
): Promise<ApproachStepResult> {
  return (
    (await ctx.ui.custom<ApproachStepResult>((tui, theme, _kb, done) => {
      return new ApproachCardComponent({ tui, theme, option, index, total, done });
    })) ?? "cancel"
  );
}

async function askReviewFollowUp(ctx: ExtensionContext): Promise<string | null> {
  return ctx.ui.custom<FreeformStepResult>((tui, theme, _kb, done) => {
    return new FreeformInputCardComponent({
      tui,
      theme,
      title: "Review Follow-up",
      subtitle: "Refine your design",
      prompt:
        "Answer the review questions, adjust your assumptions, or leave this blank and press Enter to continue.",
      initialAnswer: "",
      done,
    });
  });
}

function showClassifyingStatus(ctx: ExtensionContext): void {
  ctx.ui.notify("Classifying request...", "info");
}

class FreeformInputCardComponent implements Component, Focusable {
  private readonly editor: Editor;
  private cachedWidth?: number;
  private cachedLines?: string[];

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  constructor(
    private readonly props: {
      tui: TUI;
      theme: Theme;
      title: string;
      subtitle: string;
      prompt: string;
      initialAnswer: string;
      done: (result: FreeformStepResult) => void;
    },
  ) {
    this.editor = new Editor(props.tui, createEditorTheme(props.theme), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(props.initialAnswer);
    this.editor.onChange = () => {
      this.invalidate();
      props.tui.requestRender();
    };
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.props.done(null);
      return;
    }
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.props.done(this.editor.getText().trim());
      return;
    }

    this.editor.handleInput(data);
    this.invalidate();
    this.props.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const { theme, title, subtitle, prompt } = this.props;
    const boxWidth = clampContentWidth(width, 108);
    const contentWidth = boxWidth - 4;
    const lines = createBox(theme, width, boxWidth, [
      theme.bold(title),
      theme.fg("accent", subtitle),
      "",
      ...wrapTextWithAnsi(prompt, contentWidth),
      "",
      theme.fg("dim", "Your refinement"),
      ...this.renderEditorLines(contentWidth),
      "",
      theme.fg("dim", "Enter continue  ·  Shift+Enter newline  ·  Esc cancel"),
    ]);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderEditorLines(contentWidth: number): string[] {
    const rendered = this.editor.render(Math.max(24, contentWidth));
    if (rendered.length <= 2) return rendered;
    return rendered.slice(1, -1);
  }
}

class QuestionCardComponent implements Component, Focusable {
  private readonly editor: Editor;
  private cachedWidth?: number;
  private cachedLines?: string[];

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  constructor(
    private readonly props: {
      tui: TUI;
      theme: Theme;
      question: SocraticQuestion;
      index: number;
      total: number;
      answeredIndexes: Set<number>;
      initialAnswer: string;
      entryReason: string;
      done: (result: QuestionStepResult) => void;
    },
  ) {
    this.editor = new Editor(props.tui, createEditorTheme(props.theme), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(props.initialAnswer);
    this.editor.onChange = () => {
      this.invalidate();
      props.tui.requestRender();
    };
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.props.done(null);
      return;
    }
    if (matchesKey(data, Key.ctrl("b"))) {
      this.props.done({ action: "back", answer: this.editor.getText() });
      return;
    }
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.props.done({ action: "next", answer: this.editor.getText() });
      return;
    }

    this.editor.handleInput(data);
    this.invalidate();
    this.props.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const { theme, question, index, total, answeredIndexes } = this.props;
    const boxWidth = clampContentWidth(width, 100);
    const contentWidth = boxWidth - 4;
    const progress = buildProgressDots(total, index, answeredIndexes)
      .map((dot, dotIndex) => {
        if (dotIndex === index) return theme.fg("accent", dot);
        if (answeredIndexes.has(dotIndex)) return theme.fg("success", dot);
        return theme.fg("dim", dot);
      })
      .join(" ");

    const introLines =
      index === 0
        ? [
      theme.fg("accent", "Why you're here"),
            ...wrapTextWithAnsi(this.props.entryReason, contentWidth),
            "",
          ]
        : [];

    const lines = createBox(theme, width, boxWidth, [
      ...introLines,
      theme.bold("Architect Mode") + "  " + progress,
      theme.fg("accent", `${question.title} (${index + 1}/${total})`),
      "",
      ...wrapTextWithAnsi(question.prompt, contentWidth),
      "",
      theme.fg("dim", "Your answer"),
      ...this.renderEditorLines(contentWidth),
      "",
      theme.fg("dim", "Enter next  ·  Shift+Enter newline  ·  Ctrl+B back  ·  Esc cancel"),
    ]);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderEditorLines(contentWidth: number): string[] {
    const rendered = this.editor.render(Math.max(24, contentWidth));
    if (rendered.length <= 2) return rendered;
    return rendered.slice(1, -1);
  }
}

class ApproachCardComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly props: {
      tui: TUI;
      theme: Theme;
      option: ArchitectureOption;
      index: number;
      total: number;
      done: (result: ApproachStepResult) => void;
    },
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || data.toLowerCase() === "s") {
      this.props.done("select");
      return;
    }
    if (data.toLowerCase() === "n" || matchesKey(data, Key.tab)) {
      this.props.done("next");
      return;
    }
    if (data.toLowerCase() === "c") {
      this.props.done("custom");
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.props.done("cancel");
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const { theme, option, index, total } = this.props;
    const boxWidth = clampContentWidth(width, 110);
    const contentWidth = boxWidth - 4;
    const body = [
      theme.bold("Choose an Architecture") + theme.fg("dim", `  ${index + 1}/${total}`),
      theme.fg("accent", option.title),
      "",
      ...wrapTextWithAnsi(option.summary, contentWidth),
      "",
      ...wrapTextWithAnsi(option.details, contentWidth),
      "",
      theme.fg("dim", "Enter/S select  ·  N/Tab next  ·  C custom  ·  Esc cancel"),
    ];

    this.cachedLines = createBox(theme, width, boxWidth, body);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}

class ReviewMessageComponent implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly content: string,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const boxWidth = clampContentWidth(width, 128);
    return createBox(this.theme, width, boxWidth, [
      this.theme.bold("Architect Review"),
      this.theme.fg("dim", "Pressure-test the design before implementation."),
      "",
      ...formatMessageBody(this.content),
    ]);
  }
}

class BorderedTextComponent implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly title: string,
    private readonly body: string[],
    private readonly maxWidth = 88,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const boxWidth = clampContentWidth(width, this.maxWidth);
    return createBox(this.theme, width, boxWidth, [this.theme.bold(this.title), "", ...this.body]);
  }
}

function formatMessageBody(content: string): string[] {
  const lines = content
    .replace(/^Architect review\s*/i, "")
    .trim()
    .split("\n");

  if (lines.length === 1 && lines[0] === "") return [];

  return lines.map((line) => {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading?.[1]) return `[[heading]]${heading[1]}`;
    return line;
  });
}

function createBox(theme: Theme, viewportWidth: number, boxWidth: number, body: string[]): string[] {
  const left = centerBox(viewportWidth, boxWidth);
  const contentWidth = boxWidth - 4;
  const horizontal = "─".repeat(boxWidth - 2);
  const lines = [`${left}${theme.fg("borderAccent", `╭${horizontal}╮`)}`];

  for (const item of body) {
    const normalized = item.startsWith("[[heading]]")
      ? theme.fg("accent", theme.bold(item.slice("[[heading]]".length)))
      : item;
    const wrapped = normalized === "" ? [""] : wrapTextWithAnsi(normalized, contentWidth);
    for (const line of wrapped) {
      lines.push(`${left}${boxLine(theme, line, boxWidth)}`);
    }
  }

  lines.push(`${left}${theme.fg("borderAccent", `╰${horizontal}╯`)}`);
  return lines.map((line) => truncateToWidth(line, viewportWidth, ""));
}

function boxLine(theme: Theme, content: string, boxWidth: number): string {
  const contentWidth = boxWidth - 4;
  const clipped = truncateToWidth(content, contentWidth, "");
  const rightPad = Math.max(0, contentWidth - visibleWidth(clipped));
  return `${theme.fg("borderAccent", "│")} ${clipped}${" ".repeat(rightPad)} ${theme.fg("borderAccent", "│")}`;
}

function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    },
  };
}

async function classifyTask(ctx: ExtensionContext, config: ArchitectConfig, prompt: string, cwd: string): Promise<TaskType> {
  const repoContext = await getRepoContext(cwd);
  const classifierPromptTemplate = await resolvePromptTemplate(ctx, cwd, config, "classifier");
  const classifierPrompt = buildClassifierPrompt({ prompt, repoContext }, classifierPromptTemplate);

  const model = await resolveConfiguredModel(ctx, config.classifierModel, ctx.model);
  if (!model) return heuristicClassify(prompt);

  try {
    const text = await completeWithModel(ctx, model, SYSTEM_PROMPTS.classifier, classifierPrompt);
    return parseTaskType(text) ?? heuristicClassify(prompt);
  } catch {
    return heuristicClassify(prompt);
  }
}

async function runModelStep(
  ctx: ExtensionContext,
  config: ArchitectConfig,
  label: string,
  prompt: string,
): Promise<string> {
  const model = await resolveConfiguredModel(ctx, config.architectModel, ctx.model);
  if (!model) {
    return "No model is available. Continue using your own judgment and select a conservative architecture.";
  }

  if (!ctx.hasUI) {
    return completeWithModel(ctx, model, SYSTEM_PROMPTS.architectReviewer, prompt);
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `${label} (${model.id})`);
    loader.onAbort = () => done(null);

    completeWithModel(ctx, model, SYSTEM_PROMPTS.architectCoach, prompt, loader.signal)
      .then(done)
      .catch((error: unknown) => done(`Model step failed: ${error instanceof Error ? error.message : String(error)}`));

    return loader;
  });

  return result ?? "Cancelled.";
}

async function completeWithModel(
  ctx: ExtensionContext,
  model: Model<Api>,
  systemPrompt: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function resolveConfiguredModel(
  ctx: ExtensionContext,
  modelRef: string | undefined,
  fallback: Model<Api> | undefined,
): Promise<Model<Api> | undefined> {
  if (!modelRef) return fallback;

  const [provider, ...idParts] = modelRef.includes(":") ? modelRef.split(":") : [];
  const id = idParts.join(":");
  const model =
    provider && id
      ? ctx.modelRegistry.find(provider, id)
      : ctx.modelRegistry.getAll().find((candidate: Model<Api>) => candidate.id === modelRef);

  if (!model) return fallback;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  return auth.ok ? model : fallback;
}

async function loadConfig(cwd: string): Promise<ArchitectConfig> {
  const configPath = path.join(cwd, ".pi", "architect", "config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<ArchitectConfig>);
  } catch {
    return normalizeConfig(undefined);
  }
}

async function resolvePromptTemplate(
  ctx: ExtensionContext,
  cwd: string,
  config: ArchitectConfig,
  name: PromptName,
): Promise<string> {
  const configured = config.prompts?.[name];
  if (typeof configured !== "string") return DEFAULT_PROMPT_TEMPLATES[name];

  const source = configured.trim();
  if (!source) return DEFAULT_PROMPT_TEMPLATES[name];
  if (!isPromptFileReference(source)) return configured;

  const promptPath = resolvePromptPath(cwd, source);
  try {
    return await readFile(promptPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not read Architect ${name} prompt at ${promptPath}; using built-in prompt. ${message}`, "warning");
    return DEFAULT_PROMPT_TEMPLATES[name];
  }
}

function isPromptFileReference(value: string): boolean {
  return value.endsWith(".md") || value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("~");
}

function resolvePromptPath(cwd: string, value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? cwd, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

async function getRepoContext(cwd: string): Promise<string> {
  const [files, status] = await Promise.all([listTopLevelFiles(cwd), gitStatus(cwd)]);
  return [`cwd: ${cwd}`, `files: ${files.join(", ") || "(empty)"}`, `git status: ${status || "(not available)"}`].join("\n");
}

async function listTopLevelFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".git") && entry.name !== "node_modules")
      .slice(0, 50)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

async function gitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd, timeout: 1000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function saveDecisionPlan(cwd: string, decision: ArchitectDecision): Promise<string> {
  const planPath = buildPlanPath(cwd, decision.originalPrompt);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, renderDecisionMarkdown(decision), "utf8");
  return planPath;
}

function updateStatus(ctx: ExtensionContext, state: RuntimeState, label?: string): void {
  if (state.disabled) {
    ctx.ui.setStatus("architect", ctx.ui.theme.fg("dim", "architect: disabled"));
  } else if (state.locked) {
    ctx.ui.setStatus("architect", ctx.ui.theme.fg("warning", `architect: ${label ?? "locked"}`));
  } else if (state.activeDecision) {
    ctx.ui.setStatus("architect", ctx.ui.theme.fg("success", "architect: unlocked"));
  } else {
    ctx.ui.setStatus("architect", undefined);
  }
}

function updateProgressWidget(
  ctx: ExtensionContext,
  question: SocraticQuestion,
  index: number,
  answers: SocraticAnswer[],
): void {
  const dots = QUESTIONS.map((_, i) => {
    if (i === index) return ctx.ui.theme.fg("accent", "●");
    if (answers[i]?.answer.trim()) return ctx.ui.theme.fg("success", "●");
    return ctx.ui.theme.fg("dim", "○");
  }).join(" ");

  ctx.ui.setWidget("architect", [
    `Architect Mode ${dots}`,
    "",
    question.title,
    question.prompt,
  ]);
}

function showReviewWidget(ctx: ExtensionContext, reviewFeedback: string): void {
  ctx.ui.setWidget("architect-review", (_tui, theme) => new ReviewMessageComponent(theme, `Architect review\n\n${reviewFeedback}`));
}

function clearReviewWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget("architect-review", undefined);
}

function persist(pi: ExtensionAPI, state: RuntimeState, data: Record<string, unknown>): void {
  pi.appendEntry(ARCHITECT_MESSAGE_TYPE, {
    disabled: state.disabled,
    locked: state.locked,
    activeDecision: state.activeDecision,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

function disableArchitectMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
  source: "command" | "skip",
): void {
  state.disabled = true;
  state.locked = false;
  ctx.ui.setWidget("architect", undefined);
  updateStatus(ctx, state);
  persist(pi, state, { phase: "disabled", source });
  ctx.ui.notify(
    source === "skip"
      ? "Architect Mode skipped for this session."
      : "Architect Mode disabled until you run /architect enable.",
    "info",
  );
}

function enableArchitectMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RuntimeState,
): void {
  state.disabled = false;
  updateStatus(ctx, state);
  persist(pi, state, { phase: "enabled" });
  ctx.ui.notify("Architect Mode enabled.", "info");
}

function stripPromptEcho(text: string, prompt: string): string {
  return text.startsWith(prompt) ? text.slice(prompt.length).trim() : text;
}

function buildImplementationContext(decision: ArchitectDecision): string {
  return `[ARCHITECT MODE CONTEXT]
The user completed Architect Mode before implementation.

Original task:
${decision.originalPrompt}

Selected approach:
${decision.selectedApproach}

Approach details:
${decision.selectedApproachDetails}

Constraints and reasoning:
${formatAnswers(decision.answers)}

Review feedback to keep in mind:
${decision.reviewFeedback}

Implement according to the selected approach. Preserve the user's stated design ownership and tradeoffs.`;
}

function buildUnlockedPrompt(decision: ArchitectDecision): string {
  return `Proceed with implementation using the selected Architect Mode plan.

${buildImplementationContext(decision)}`;
}

function renderDecisionMarkdown(decision: ArchitectDecision): string {
  return `# Architect Mode Plan

Created: ${decision.createdAt}

## Original Prompt

${decision.originalPrompt}

## Socratic Answers

${formatAnswers(decision.answers)}

## Review Feedback

${decision.reviewFeedback}

## Follow-up Answers

${decision.followUpAnswers || "(none)"}

## Options

${decision.options.map((option) => `### ${option.title}\n\n${option.details}`).join("\n\n")}

## Selected Approach

### ${decision.selectedApproach}

${decision.selectedApproachDetails}
`;
}
