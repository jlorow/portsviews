type PathOperation = { name: string; args: unknown[] }

export class Path2DShim {
  readonly ops: PathOperation[] = []

  moveTo(...args: number[]): void { this.ops.push({ name: 'moveTo', args }) }
  lineTo(...args: number[]): void { this.ops.push({ name: 'lineTo', args }) }
  bezierCurveTo(...args: number[]): void { this.ops.push({ name: 'bezierCurveTo', args }) }
  quadraticCurveTo(...args: number[]): void { this.ops.push({ name: 'quadraticCurveTo', args }) }
  arc(...args: number[]): void { this.ops.push({ name: 'arc', args }) }
  ellipse(...args: number[]): void { this.ops.push({ name: 'ellipse', args }) }
  rect(...args: number[]): void { this.ops.push({ name: 'rect', args }) }
  roundRect(...args: unknown[]): void { this.ops.push({ name: 'roundRect', args }) }
  closePath(): void { this.ops.push({ name: 'closePath', args: [] }) }
  addPath(path: Path2DShim, transform?: DOMMatrix2DInit): void {
    this.ops.push({ name: 'addPath', args: transform === undefined ? [path] : [path, transform] })
  }
}

const globals = globalThis as typeof globalThis & { Path2D?: typeof Path2D }
if (globals.Path2D === undefined) {
  Object.defineProperty(globalThis, 'Path2D', {
    configurable: true,
    value: Path2DShim as unknown as typeof Path2D,
  })
}
