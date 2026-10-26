import './styles.css';
import './frameline.css';
import { App } from './app';

const root = document.getElementById('app')!;
const app = new App(root);
// Handy for debugging from DevTools
(window as unknown as { frameline_app: App }).frameline_app = app;
