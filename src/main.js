import { createApp } from "vue";
import "./index.css";
import "highlight.js/styles/github-dark.css"; // code-block theme for rendered markdown
import "./store/theme.js"; // apply persisted theme before first paint
import App from "./App.vue";

createApp(App).mount("#app");
