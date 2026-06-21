<template>
  <div class="seekbar">
    <span class="seekbar__time seekbar__time--current">{{ formatTime(displayTime) }}</span>

    <div
      ref="track"
      class="seekbar__track"
      :class="{ 'seekbar__track--dragging': isDragging }"
      @mousedown="onTrackPointerDown"
      @touchstart="onTrackPointerDown"
    >
      <div class="seekbar__rail">
        <div class="seekbar__fill" :style="{ width: displayRatio * 100 + '%' }"></div>
      </div>
      <div class="seekbar__thumb" :style="{ left: displayRatio * 100 + '%' }">
        <span class="seekbar__hit"></span>
      </div>
    </div>

    <span class="seekbar__time seekbar__time--total">{{ formatTime(duration) }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'

interface Props {
  currentTime: number
  duration: number
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'seek', value: number): void }>()

const track = ref<HTMLElement | null>(null)
const isDragging = ref(false)
const dragRatio = ref(0)

// Razão (0..1) com guarda contra duration 0/NaN/Infinity.
const playbackRatio = computed(() => {
  if (!props.duration || !isFinite(props.duration)) return 0
  return Math.min(1, Math.max(0, props.currentTime / props.duration))
})

const displayRatio = computed(() => (isDragging.value ? dragRatio.value : playbackRatio.value))
const displayTime = computed(() =>
  isDragging.value ? dragRatio.value * props.duration : props.currentTime,
)

function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function clientXFromEvent(e: MouseEvent | TouchEvent): number {
  if ('touches' in e) {
    const touch = e.touches[0] ?? e.changedTouches[0]
    return touch ? touch.clientX : 0
  }
  return e.clientX
}

function ratioFromClientX(clientX: number): number {
  const el = track.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (rect.width === 0) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

function onMove(e: MouseEvent | TouchEvent) {
  // Bloqueia o scroll vertical acidental da página durante o arraste no iOS.
  if (e.cancelable) e.preventDefault()
  dragRatio.value = ratioFromClientX(clientXFromEvent(e))
}

function onUp(e: MouseEvent | TouchEvent) {
  dragRatio.value = ratioFromClientX(clientXFromEvent(e))
  if (props.duration && isFinite(props.duration)) {
    emit('seek', dragRatio.value * props.duration)
  }
  isDragging.value = false
  detachWindowListeners()
}

function onTrackPointerDown(e: MouseEvent | TouchEvent) {
  isDragging.value = true
  dragRatio.value = ratioFromClientX(clientXFromEvent(e))
  attachWindowListeners()
}

function attachWindowListeners() {
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  // passive:false permite preventDefault() no touchmove.
  window.addEventListener('touchmove', onMove, { passive: false })
  window.addEventListener('touchend', onUp)
  window.addEventListener('touchcancel', onUp)
}

function detachWindowListeners() {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  window.removeEventListener('touchmove', onMove)
  window.removeEventListener('touchend', onUp)
  window.removeEventListener('touchcancel', onUp)
}

onUnmounted(detachWindowListeners)
</script>

<style scoped>
.seekbar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
}

.seekbar__time {
  flex: 0 0 auto;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  color: rgba(255, 255, 255, 0.7);
  min-width: 2.4em;
  text-align: center;
  user-select: none;
}

/* Track tem padding vertical generoso para ampliar a área de clique
   sem engrossar a linha visual. */
.seekbar__track {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 44px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}

.seekbar__rail {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.25);
  overflow: hidden;
}

.seekbar__fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 2px;
  background: #1db954;
  transition: width 0.1s linear;
}

.seekbar__thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  border-radius: 50%;
  background: #1db954;
  transform: translateY(-50%);
  transition: left 0.1s linear;
}

/* Área de toque invisível de 44x44px centrada na bolinha. */
.seekbar__hit {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}

/* Durante o arraste removemos a transição para resposta imediata. */
.seekbar__track--dragging .seekbar__fill,
.seekbar__track--dragging .seekbar__thumb {
  transition: none;
}
</style>
