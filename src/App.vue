<script setup>
import { computed } from "vue";
import { store } from "./store/store.js";
import Sidebar from "./components/Sidebar.vue";
import Speedometer from "./components/Speedometer.vue";
import Comparison from "./components/Comparison.vue";
import Cotenancy from "./components/Cotenancy.vue";
import Concurrency from "./components/Concurrency.vue";
import MetricsHelp from "./components/MetricsHelp.vue";
import ModalDialog from "./components/ModalDialog.vue";

const currentComponent = computed(() => {
  switch (store.currentView) {
    case "comparison": return Comparison;
    case "cotenancy": return Cotenancy;
    case "concurrency": return Concurrency;
    case "help": return MetricsHelp;
    default: return Speedometer;
  }
});
</script>

<template>
  <div class="app-container">
    <!-- Sidebar navigation and profile controls -->
    <Sidebar />

    <!-- Main View Display Area -->
    <main class="view-container">
      <KeepAlive>
        <component :is="currentComponent" />
      </KeepAlive>
    </main>

    <!-- Global confirmation / alert modal -->
    <ModalDialog />
  </div>
</template>

<style>
.app-container {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background-color: var(--bg-main);
}

.view-container {
  flex: 1;
  height: 100%;
  overflow: hidden;
  position: relative;
}
</style>
