<template>
  <div class="audio-visualizer">
    <canvas ref="canvas" class="visualizer-canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

interface Props {
  audioElement: HTMLAudioElement | null
  isPlaying: boolean
}

const props = defineProps<Props>()

const canvas = ref<HTMLCanvasElement>()
let animationFrame: number | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let dataArray: Uint8Array | null = null
let source: MediaElementAudioSourceNode | null = null
let isPageVisible = true

// Detect iOS
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)

onMounted(() => {
  initVisualizer()
  // Listen for page visibility changes
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  cleanup()
})

watch(() => props.isPlaying, (isPlaying) => {
  if (isPlaying) {
    startVisualization()
  } else {
    stopVisualization()
  }
})

watch(() => props.audioElement, (newAudio) => {
  if (newAudio) {
    setupAudioContext(newAudio)
  }
})

function initVisualizer() {
  if (!canvas.value) return
  
  const ctx = canvas.value.getContext('2d')
  if (!ctx) return

  // Set canvas size
  resizeCanvas()
  
  // Listen for resize events
  window.addEventListener('resize', resizeCanvas)
  
  // Setup audio context when audio element is available
  if (props.audioElement) {
    setupAudioContext(props.audioElement)
  }
}

function resizeCanvas() {
  if (!canvas.value) return
  
  const container = canvas.value.parentElement
  if (!container) return
  
  canvas.value.width = container.clientWidth
  canvas.value.height = container.clientHeight
}

function setupAudioContext(audioElement: HTMLAudioElement) {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    }

    if (!source) {
      source = audioContext.createMediaElementSource(audioElement)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      
      const bufferLength = analyser.frequencyBinCount
      dataArray = new Uint8Array(new ArrayBuffer(bufferLength))
      
      source.connect(analyser)
      analyser.connect(audioContext.destination)
    }
  } catch (error) {
    console.error('Error setting up audio context. Visualization will be disabled.', error)
  }
}

function startVisualization() {
  if (!audioContext || !props.isPlaying) return

  // Resume context if it was suspended by the browser
  if (audioContext.state === 'suspended') {
    audioContext.resume().then(() => {
      draw()
    })
  } else {
    draw()
  }
}

function stopVisualization() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
}

function draw() {
  if (!canvas.value || !analyser || !dataArray || !props.isPlaying) return
  
  const ctx = canvas.value.getContext('2d')
  if (!ctx) return
  
  animationFrame = requestAnimationFrame(draw)
  
  // Get frequency data
  ;(analyser as any).getByteFrequencyData(dataArray)
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.value.width, canvas.value.height)
  
  // Draw waveform
  drawWaveform(ctx)
}

function drawWaveform(ctx: CanvasRenderingContext2D) {
  if (!canvas.value || !dataArray) return
  
  const width = canvas.value.width
  const height = canvas.value.height
  const centerY = height / 2
  
  // Create gradient
  const gradient = ctx.createLinearGradient(0, 0, width, 0)
  gradient.addColorStop(0, '#ff6b6b')
  gradient.addColorStop(0.3, '#4ecdc4')
  gradient.addColorStop(0.6, '#45b7d1')
  gradient.addColorStop(1, '#96ceb4')
  
  ctx.fillStyle = gradient
  ctx.strokeStyle = gradient
  
  const barWidth = width / dataArray.length
  
  // Draw frequency bars
  for (let i = 0; i < dataArray.length; i++) {
    const barHeight = (dataArray[i] / 255) * height * 0.7
    const x = i * barWidth
    
    // Draw bar from center expanding up and down
    ctx.fillRect(x, centerY - barHeight / 2, barWidth - 1, barHeight)
  }
  
  // Draw additional wave effect
  drawSineWave(ctx, gradient)
}

function drawSineWave(ctx: CanvasRenderingContext2D, gradient: CanvasGradient) {
  if (!canvas.value || !dataArray) return
  
  const width = canvas.value.width
  const height = canvas.value.height
  const centerY = height / 2
  
  // Calculate average amplitude
  const average = dataArray.reduce((a, b) => a + b) / dataArray.length
  const amplitude = (average / 255) * 50
  
  ctx.strokeStyle = gradient
  ctx.lineWidth = 3
  ctx.globalAlpha = 0.7
  
  ctx.beginPath()
  
  for (let x = 0; x < width; x++) {
    const y = centerY + Math.sin((x * 0.02) + (Date.now() * 0.005)) * amplitude
    if (x === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  
  ctx.stroke()
  ctx.globalAlpha = 1
}

function handleVisibilityChange() {
  if (document.hidden) {
    // Page hidden - disconnect Web Audio API to allow native background playback
    isPageVisible = false
    stopVisualization()
    disconnectWebAudio()
  } else {
    // Page visible - reconnect Web Audio API for visualization
    isPageVisible = true
    if (props.isPlaying && props.audioElement) {
      reconnectWebAudio()
      startVisualization()
    }
  }
}

function disconnectWebAudio() {
  try {
    if (source) {
      source.disconnect()
      source = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    // Keep audioContext alive but disconnected
  } catch (error) {
    console.error('Error disconnecting:', error)
  }
}

function reconnectWebAudio() {
  try {
    if (!props.audioElement || !audioContext) return
    
    // Create new source and analyser
    if (!source) {
      source = audioContext.createMediaElementSource(props.audioElement)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      
      const bufferLength = analyser.frequencyBinCount
      dataArray = new Uint8Array(new ArrayBuffer(bufferLength))
      
      source.connect(analyser)
      analyser.connect(audioContext.destination)
    }
  } catch (error) {
    // Audio element already connected - this is okay, audio will work without visualization
    console.warn('Could not reconnect visualizer:', error)
  }
}

function cleanup() {
  stopVisualization()
  
  if (source) {
    source.disconnect()
    source = null
  }
  if (analyser) {
    analyser.disconnect()
    analyser = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  
  window.removeEventListener('resize', resizeCanvas)
}
</script>

<style scoped>
.audio-visualizer {
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 15px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-sizing: border-box;
  margin: 0 auto;
}

.visualizer-canvas {
  width: 100%;
  height: 100%;
  background: transparent;
  display: block;
}

/* Mobile adjustments */
@media (max-width: 768px) {
  .audio-visualizer {
    border-radius: 10px;
    max-width: calc(100dvw - 60px);
    margin: 0 auto; /* Force center alignment */
  }
}

@media (max-width: 420px) {
  .audio-visualizer {
    border-radius: 8px;
    max-width: calc(100dvw - 40px);
    margin: 0 auto; /* Force center alignment */
  }
}
</style>