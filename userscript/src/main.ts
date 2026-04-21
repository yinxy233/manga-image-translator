import { TranslatorController } from "./core/controller";

function bootstrap(): void {
  new TranslatorController();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
