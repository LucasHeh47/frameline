// Undo and redo: a copy of the project before each change. Projects are small (no media in them),
// so whole copies are simple and fast.

interface Entry<T> {
  label: string;
  state: T;
  id: number;
}

export class History<T> {
  private undos: Entry<T>[] = [];
  private redos: Entry<T>[] = [];
  private counter = 0;
  /** Identifies the current state (changes with every edit, undo and redo). */
  current = 0;
  private savedAt = 0;

  constructor(public limit = 200) {}

  /** Call before changing the project, with a copy of it as it is. */
  record(label: string, before: T): void {
    this.undos.push({ label, state: before, id: this.current });
    if (this.undos.length > this.limit) this.undos.shift();
    this.redos = [];
    this.current = ++this.counter;
  }

  get canUndo(): boolean {
    return this.undos.length > 0;
  }

  get canRedo(): boolean {
    return this.redos.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.undos[this.undos.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.redos[this.redos.length - 1]?.label;
  }

  /** Returns the state to go back to; `now` is kept for redo. */
  undo(now: T): T | null {
    const e = this.undos.pop();
    if (!e) return null;
    this.redos.push({ label: e.label, state: now, id: this.current });
    this.current = e.id;
    return e.state;
  }

  redo(now: T): T | null {
    const e = this.redos.pop();
    if (!e) return null;
    this.undos.push({ label: e.label, state: now, id: this.current });
    this.current = e.id;
    return e.state;
  }

  /** The steps for the History panel: done ones first, then ones that can be redone. */
  steps(): { label: string; done: boolean }[] {
    return [...this.undos.map((e) => ({ label: e.label, done: true })), ...[...this.redos].reverse().map((e) => ({ label: e.label, done: false }))];
  }

  get undoCount(): number {
    return this.undos.length;
  }

  markSaved(): void {
    this.savedAt = this.current;
  }

  get dirty(): boolean {
    return this.current !== this.savedAt;
  }

  /** Treats the current state as unsaved (recovered work, a new project from a template). */
  markUnsaved(): void {
    this.savedAt = -1;
  }

  clear(): void {
    this.undos = [];
    this.redos = [];
    this.current = ++this.counter;
    this.savedAt = this.current;
  }
}
