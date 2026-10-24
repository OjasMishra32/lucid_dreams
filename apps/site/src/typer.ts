/** Types a line into an element the way a person would: back to the shared prefix, then forward. */
export class Typer {
  private text: string;
  private target: string;
  private timer = 0;
  idle = true;

  constructor(
    private el: HTMLElement,
    private instant = false,
  ) {
    this.text = this.target = el.textContent ?? "";
  }

  type(target: string) {
    this.target = target;
    clearTimeout(this.timer);
    if (this.instant) {
      this.text = target;
      this.el.textContent = target;
      this.idle = true;
      return;
    }
    this.idle = false;
    this.step();
  }

  private step = () => {
    if (this.text === this.target) {
      this.idle = true;
      return;
    }
    let delay: number;
    if (!this.target.startsWith(this.text)) {
      this.text = this.text.slice(0, -1);
      delay = 16;
    } else {
      this.text = this.target.slice(0, this.text.length + 1);
      const ch = this.target[this.text.length - 1];
      delay = 34 + Math.random() * 46 + (ch === " " ? 40 : 0) + (ch === "," ? 160 : 0);
    }
    this.el.textContent = this.text;
    this.timer = window.setTimeout(this.step, delay);
  };
}
