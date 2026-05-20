<script setup>
import { store } from "./store/store.js";
import Sidebar from "./components/Sidebar.vue";
import Speedometer from "./components/Speedometer.vue";
import Comparison from "./components/Comparison.vue";
import ModalDialog from "./components/ModalDialog.vue";
</script>

<template>
  <div class="app-container">
    <!-- Sidebar navigation and profile controls -->
    <Sidebar />

    <!-- Main View Display Area -->
    <main class="view-container">
      <KeepAlive>
        <component :is="store.currentView === 'playground' ? Speedometer : Comparison" />
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
