import { createApp } from "vue";
import "./index.css";
import "./store/theme.js"; // apply persisted theme before first paint
import App from "./App.vue";

createApp(App).mount("#app");
