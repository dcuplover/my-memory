/**
 * Operation tracker — records steps, timing, and token usage for each query/add operation.
 */

export type TokenUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

export type StepLog = {
    step: string;
    durationMs: number;
    tokens?: TokenUsage;
    detail?: string;
};

export class OperationTracker {
    readonly operation: string;
    private startTime: number;
    private steps: StepLog[] = [];
    private _totalTokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    constructor(operation: string) {
        this.operation = operation;
        this.startTime = Date.now();
    }

    /** Track an async step: records duration. */
    async track<T>(step: string, fn: () => Promise<T>, detail?: string): Promise<T> {
        const t0 = Date.now();
        try {
            const result = await fn();
            this.steps.push({ step, durationMs: Date.now() - t0, detail });
            return result;
        } catch (err) {
            this.steps.push({ step, durationMs: Date.now() - t0, detail: `ERROR: ${String(err)}` });
            throw err;
        }
    }

    /** Record token usage from an LLM or embedding call. */
    addTokens(step: string, usage: TokenUsage): void {
        this._totalTokens.promptTokens += usage.promptTokens;
        this._totalTokens.completionTokens += usage.completionTokens;
        this._totalTokens.totalTokens += usage.totalTokens;

        for (let i = this.steps.length - 1; i >= 0; i--) {
            if (this.steps[i].step === step) {
                this.steps[i].tokens = usage;
                return;
            }
        }
        this.steps.push({ step, durationMs: 0, tokens: usage });
    }

    get totalDurationMs(): number {
        return Date.now() - this.startTime;
    }

    get totalTokens(): TokenUsage {
        return { ...this._totalTokens };
    }

    /** Generate formatted log string. */
    toLogString(): string {
        const lines: string[] = [];
        const totalMs = this.totalDurationMs;
        const tt = this._totalTokens;

        lines.push(`══ ${this.operation} ══ 总耗时: ${totalMs}ms | Tokens: ${tt.totalTokens} (prompt: ${tt.promptTokens}, completion: ${tt.completionTokens})`);

        for (const s of this.steps) {
            let line = `  ├ [${s.durationMs}ms] ${s.step}`;
            if (s.tokens) {
                line += ` | tokens: ${s.tokens.totalTokens} (p:${s.tokens.promptTokens} c:${s.tokens.completionTokens})`;
            }
            if (s.detail) {
                line += ` — ${s.detail}`;
            }
            lines.push(line);
        }

        return lines.join("\n");
    }

    /** Get structured summary object. */
    toSummary() {
        return {
            operation: this.operation,
            totalDurationMs: this.totalDurationMs,
            totalTokens: this.totalTokens,
            steps: this.steps.map((s) => ({ ...s })),
        };
    }
}

// ─── Global current tracker (for single-threaded JS) ───

let _currentTracker: OperationTracker | null = null;

export function startTracker(operation: string): OperationTracker {
    _currentTracker = new OperationTracker(operation);
    return _currentTracker;
}

export function currentTracker(): OperationTracker | null {
    return _currentTracker;
}

export function clearTracker(): void {
    _currentTracker = null;
}
