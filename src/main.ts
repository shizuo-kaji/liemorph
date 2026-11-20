import './styles.css';
import { App } from './app.ts';
import { UI } from './ui/ui.ts';

const root = document.getElementById('app')!;
const stage = document.getElementById('stage')!;
const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const ovCanvas = document.getElementById('overlay') as HTMLCanvasElement;

try {
  const app = new App(stage, glCanvas, ovCanvas);
  const ui = new UI(app, root, stage);
  app.ui = ui;
  ui.update();
  // expose for console experiments (researchers): window.liemorph.app.deformer, .interp, ...
  (window as unknown as { liemorph: unknown }).liemorph = { app, ui };
} catch (e) {
  console.error(e);
  stage.innerHTML = `<div class="fatal"><h2>😢</h2><p>${(e as Error).message}</p><p>WebGL is required.</p></div>`;
}
