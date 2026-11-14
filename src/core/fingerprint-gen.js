/**
 * VNT-Browser Fingerprint Generator (`src/core/fingerprint-gen.js`)
 * Generates coherent, cross-vector consistent hardware & browser fingerprints
 * specifically tailored for the custom C++ hooks in `chrome.dll` (151.0.7922.109).
 *
 * Includes:
 * - 18 Hardware Blueprints (Windows 10/11 NVIDIA RTX 40/30/20/GTX, AMD Radeon RX 7000/6000,
 *   Intel Arc/Iris Xe/UHD, macOS Sonoma/Sequoia Apple Silicon M1/M2/M3/M4 & Intel Mac).
 * - Strict technical hardware assembly compatibility rules (OS <-> Platform <-> Architecture <->
 *   CPU Cores <-> RAM <-> GPU D3D11/Metal Limits <-> Screen Aspect Ratios <-> Motherboards/MAC OUI).
 * - Cross-profile deduplication engine (`generateUniqueFingerprint`) guaranteeing zero collision
 *   across hardware assembly tuples (`blueprintId|cores|ram|screen`) and unique hardware identifiers
 *   (`CanvasMark`, `WebGLMark|AudioFP|ClientRectFP`, `MacAdderss`, `DeviceName`, `AudioSession`).
 */

const crypto = require('crypto');

const KERNEL_VERSION_FULL = '151.0.7922.109';
const KERNEL_MAJOR = '151';

const WIN_DISABLED_FONTS = [
  'Apple Color Emoji', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'PingFang SC', 'Menlo', 'Monaco'
];

const MAC_DISABLED_FONTS = [
  'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Consolas', 'Calibri', 'Cambria', 'Candara', 'Microsoft YaHei', 'Malgun Gothic'
];

const WIN_TTS_ENGINES_3 = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US', local_service: true, is_default: true },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US', local_service: true, is_default: false },
  { name: 'Microsoft Mark - English (United States)', lang: 'en-US', local_service: true, is_default: false }
];

const WIN_TTS_ENGINES_2 = [
  { name: 'Microsoft David - English (United States)', lang: 'en-US', local_service: true, is_default: true },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US', local_service: true, is_default: false }
];

const MAC_TTS_SAMANTHA_ALEX = [
  { name: 'Samantha', lang: 'en-US', local_service: true, is_default: true },
  { name: 'Alex', lang: 'en-US', local_service: true, is_default: false }
];

const MAC_TTS_SAMANTHA_VICTORIA = [
  { name: 'Samantha', lang: 'en-US', local_service: true, is_default: true },
  { name: 'Victoria', lang: 'en-US', local_service: true, is_default: false }
];

/**
 * Hardware Blueprints ensuring strict technical compatibility across:
 * OS <-> Platform <-> CPU Architecture <-> Valid Cores/RAM Combinations <-> GPU Limits <-> Screens <-> OUI/Motherboard.
 */
const HARDWARE_BLUEPRINTS = {
  // ============================================================================
  // 1. WINDOWS DESKTOP — NVIDIA ADA LOVELACE (RTX 40 SERIES)
  // ============================================================================
  win_nvidia_rtx4090: {
    id: 'win_nvidia_rtx4090',
    label: 'Windows 11 (x64) — NVIDIA GeForce RTX 4090 (Enthusiast Z790)',
    category: 'Windows Desktop High-End',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [12, 16, 24, 32],
    memoryOptions: [32, 64, 128],
    minMemoryByCores: { 12: 32, 16: 32, 24: 32, 32: 64 },
    screens: ['2560,1440', '3440,1440', '3840,2160', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '32768',
      MAX_CUBE_MAP_TEXTURE_SIZE: '32768',
      MAX_RENDERBUFFER_SIZE: '32768',
      MAX_VIEWPORT_DIMS: '[32768, 32768]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '16',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'ASUS',
    productType: 'ROG Strix Z790-E Gaming WiFi',
    macPrefix: ['04', '42', '1A'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_3
  },

  win_nvidia_rtx4080_super: {
    id: 'win_nvidia_rtx4080_super',
    label: 'Windows 11 (x64) — NVIDIA GeForce RTX 4080 SUPER (AORUS Z790)',
    category: 'Windows Desktop High-End',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [12, 16, 20, 24],
    memoryOptions: [32, 64],
    minMemoryByCores: { 12: 32, 16: 32, 20: 32, 24: 32 },
    screens: ['2560,1440', '3440,1440', '3840,2160', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '32768',
      MAX_CUBE_MAP_TEXTURE_SIZE: '32768',
      MAX_RENDERBUFFER_SIZE: '32768',
      MAX_VIEWPORT_DIMS: '[32768, 32768]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '16',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Gigabyte Technology Co., Ltd.',
    productType: 'Z790 AORUS ELITE AX',
    macPrefix: ['18', 'C0', '4D'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_3
  },

  win_nvidia_rtx4070_ti: {
    id: 'win_nvidia_rtx4070_ti',
    label: 'Windows 11 (x64) — NVIDIA GeForce RTX 4070 Ti (MSI Z790)',
    category: 'Windows Desktop Performance',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [8, 12, 16, 20],
    memoryOptions: [16, 32, 64],
    minMemoryByCores: { 8: 16, 12: 16, 16: 32, 20: 32 },
    screens: ['2560,1440', '1920,1080', '3440,1440', '3840,2160'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '32768',
      MAX_CUBE_MAP_TEXTURE_SIZE: '32768',
      MAX_RENDERBUFFER_SIZE: '32768',
      MAX_VIEWPORT_DIMS: '[32768, 32768]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '16',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Micro-Star International Co., Ltd.',
    productType: 'MAG Z790 TOMAHAWK WIFI',
    macPrefix: ['D8', 'BB', 'C1'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_3
  },

  win_nvidia_rtx4060: {
    id: 'win_nvidia_rtx4060',
    label: 'Windows 11 (x64) — NVIDIA GeForce RTX 4060 (ASUS TUF B760M)',
    category: 'Windows Desktop Mainstream',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [6, 8, 12, 16],
    memoryOptions: [16, 32],
    minMemoryByCores: { 6: 16, 8: 16, 12: 16, 16: 16 },
    screens: ['1920,1080', '2560,1440', '2560,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '32768',
      MAX_CUBE_MAP_TEXTURE_SIZE: '32768',
      MAX_RENDERBUFFER_SIZE: '32768',
      MAX_VIEWPORT_DIMS: '[32768, 32768]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '16',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'ASUS',
    productType: 'TUF GAMING B760M-PLUS WIFI',
    macPrefix: ['04', '42', '1A'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  // ============================================================================
  // 2. WINDOWS DESKTOP — NVIDIA AMPERE / TURING (RTX 30 / 20 / GTX 16 SERIES)
  // ============================================================================
  win_nvidia_rtx3080: {
    id: 'win_nvidia_rtx3080',
    label: 'Windows 11 (x64) — NVIDIA GeForce RTX 3080 (ROG Crosshair X570)',
    category: 'Windows Desktop Performance',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [8, 12, 16, 24],
    memoryOptions: [16, 32, 64],
    minMemoryByCores: { 8: 16, 12: 16, 16: 32, 24: 32 },
    screens: ['2560,1440', '3440,1440', '3840,2160', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '32768',
      MAX_CUBE_MAP_TEXTURE_SIZE: '32768',
      MAX_RENDERBUFFER_SIZE: '32768',
      MAX_VIEWPORT_DIMS: '[32768, 32768]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '16',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'ASUSTeK COMPUTER INC.',
    productType: 'ROG CROSSHAIR VIII HERO',
    macPrefix: ['24', '4B', 'FE'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_3
  },

  win_nvidia_rtx3060: {
    id: 'win_nvidia_rtx3060',
    label: 'Windows 10/11 (x64) — NVIDIA GeForce RTX 3060 (MSI B660M)',
    category: 'Windows Desktop Mainstream',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '10.0.0',
      wow64: false
    },
    coresOptions: [6, 8, 12, 16],
    memoryOptions: [8, 16, 32],
    minMemoryByCores: { 6: 8, 8: 8, 12: 16, 16: 16 },
    screens: ['1920,1080', '2560,1440', '2560,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[32767, 32767]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'MSI',
    productType: 'MAG B660M MORTAR',
    macPrefix: ['00', '1A', '2B'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  win_nvidia_rtx2060: {
    id: 'win_nvidia_rtx2060',
    label: 'Windows 10 (x64) — NVIDIA GeForce RTX 2060 (Gigabyte B450)',
    category: 'Windows Desktop Mainstream',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '10.0.0',
      wow64: false
    },
    coresOptions: [6, 8, 12],
    memoryOptions: [8, 16, 32],
    minMemoryByCores: { 6: 8, 8: 8, 12: 16 },
    screens: ['1920,1080', '2560,1440'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[32767, 32767]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Gigabyte Technology Co., Ltd.',
    productType: 'B450 AORUS PRO WIFI',
    macPrefix: ['B4', '2E', '99'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  win_nvidia_gtx1660_super: {
    id: 'win_nvidia_gtx1660_super',
    label: 'Windows 10 (x64) — NVIDIA GeForce GTX 1660 SUPER (ASRock B560M)',
    category: 'Windows Desktop Budget',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '10.0.0',
      wow64: false
    },
    coresOptions: [4, 6, 8, 12],
    memoryOptions: [8, 16, 32],
    minMemoryByCores: { 4: 8, 6: 8, 8: 8, 12: 16 },
    screens: ['1920,1080', '1600,900', '2560,1440'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (NVIDIA)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[32767, 32767]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'ASRock',
    productType: 'B560M Steel Legend',
    macPrefix: ['70', '85', 'C2'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  // ============================================================================
  // 3. WINDOWS DESKTOP — AMD RADEON RDNA 3 / RDNA 2
  // ============================================================================
  win_amd_rx7900xtx: {
    id: 'win_amd_rx7900xtx',
    label: 'Windows 11 (x64) — AMD Radeon RX 7900 XTX (ASUS ROG X670E)',
    category: 'Windows Desktop High-End',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [12, 16, 24, 32],
    memoryOptions: [32, 64],
    minMemoryByCores: { 12: 32, 16: 32, 24: 32, 32: 64 },
    screens: ['2560,1440', '3440,1440', '3840,2160', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (AMD)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'ASUS',
    productType: 'ROG CROSSHAIR X670E HERO',
    macPrefix: ['FC', '34', '97'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_3
  },

  win_amd_rx6700xt: {
    id: 'win_amd_rx6700xt',
    label: 'Windows 11 (x64) — AMD Radeon RX 6700 XT (MSI MAG B550)',
    category: 'Windows Desktop Mainstream',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [6, 8, 12, 16],
    memoryOptions: [16, 32],
    minMemoryByCores: { 6: 16, 8: 16, 12: 16, 16: 16 },
    screens: ['1920,1080', '2560,1440', '2560,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (AMD)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Micro-Star International Co., Ltd.',
    productType: 'MAG B550 TOMAHAWK',
    macPrefix: ['2C', 'F0', '5D'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  // ============================================================================
  // 4. WINDOWS DESKTOP & LAPTOP — INTEL ARC / IRIS XE / UHD
  // ============================================================================
  win_intel_arc_a770: {
    id: 'win_intel_arc_a770',
    label: 'Windows 11 (x64) — Intel Arc A770 16GB (ASRock Z690)',
    category: 'Windows Desktop Mainstream',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [8, 12, 16, 20],
    memoryOptions: [16, 32, 64],
    minMemoryByCores: { 8: 16, 12: 16, 16: 32, 20: 32 },
    screens: ['1920,1080', '2560,1440', '3440,1440'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Intel)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '16',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'ASRock',
    productType: 'Z690 Phantom Gaming 4',
    macPrefix: ['A8', 'A1', '59'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  win_intel_iris_xe: {
    id: 'win_intel_iris_xe',
    label: 'Windows 11 Laptop — Intel Iris Xe Graphics (Dell XPS 13)',
    category: 'Windows Laptop Ultrabook',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [4, 8, 12, 16],
    memoryOptions: [8, 16, 32],
    minMemoryByCores: { 4: 8, 8: 8, 12: 16, 16: 16 },
    screens: ['1920,1080', '1920,1200', '1366,768', '1536,864'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Intel)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Dell Inc.',
    productType: 'XPS 13 9315',
    macPrefix: ['F8', '75', 'A4'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  win_intel_uhd770: {
    id: 'win_intel_uhd770',
    label: 'Windows 11 Office PC — Intel UHD Graphics 770 (HP EliteDesk 800 G9)',
    category: 'Windows Office Desktop',
    os: 'Windows',
    platform: 'Win32',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'Windows',
      platformVersion: '15.0.0',
      wow64: false
    },
    coresOptions: [6, 8, 12, 16],
    memoryOptions: [8, 16, 32],
    minMemoryByCores: { 6: 8, 8: 8, 12: 16, 16: 16 },
    screens: ['1920,1080', '2560,1440', '1600,900'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Intel)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '4096',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 1024]',
      MAX_SAMPLES: '8',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'HP',
    productType: 'HP EliteDesk 800 G9 SFF',
    macPrefix: ['3C', 'D9', '2B'],
    disabledFonts: WIN_DISABLED_FONTS,
    ttsEngines: WIN_TTS_ENGINES_2
  },

  // ============================================================================
  // 5. MACOS — APPLE SILICON (M4 / M3 / M2 / M1) & INTEL MAC
  // ============================================================================
  mac_apple_m4_max: {
    id: 'mac_apple_m4_max',
    label: 'macOS Sequoia 15 — Apple M4 Max (MacBook Pro 16")',
    category: 'macOS Apple Silicon',
    os: 'macOS',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'arm',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '15.1.0',
      wow64: false
    },
    coresOptions: [14, 16],
    memoryOptions: [32, 64, 128],
    minMemoryByCores: { 14: 32, 16: 32 },
    screens: ['1728,1117', '1512,982', '2560,1440', '3840,2160'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Apple)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '1024',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 511]',
      MAX_SAMPLES: '4',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Apple Inc.',
    productType: 'Mac16,5',
    macPrefix: ['F0', '18', '98'],
    disabledFonts: MAC_DISABLED_FONTS,
    ttsEngines: MAC_TTS_SAMANTHA_ALEX
  },

  mac_apple_m3_max: {
    id: 'mac_apple_m3_max',
    label: 'macOS Sonoma 14 — Apple M3 Max (MacBook Pro 16")',
    category: 'macOS Apple Silicon',
    os: 'macOS',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'arm',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.6.1',
      wow64: false
    },
    coresOptions: [8, 12, 14, 16],
    memoryOptions: [16, 32, 64],
    minMemoryByCores: { 8: 16, 12: 16, 14: 32, 16: 32 },
    screens: ['2560,1440', '1728,1117', '1512,982', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Apple)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '1024',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 511]',
      MAX_SAMPLES: '4',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Apple Inc.',
    productType: 'Mac15,9',
    macPrefix: ['F0', '18', '98'],
    disabledFonts: MAC_DISABLED_FONTS,
    ttsEngines: MAC_TTS_SAMANTHA_ALEX
  },

  mac_apple_m3_pro: {
    id: 'mac_apple_m3_pro',
    label: 'macOS Sonoma 14 — Apple M3 Pro (MacBook Pro 14")',
    category: 'macOS Apple Silicon',
    os: 'macOS',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'arm',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
      wow64: false
    },
    coresOptions: [11, 12],
    memoryOptions: [16, 32],
    minMemoryByCores: { 11: 16, 12: 16 },
    screens: ['1512,982', '1728,1117', '2560,1440'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Apple)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '1024',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 511]',
      MAX_SAMPLES: '4',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Apple Inc.',
    productType: 'Mac15,6',
    macPrefix: ['A4', '83', 'E7'],
    disabledFonts: MAC_DISABLED_FONTS,
    ttsEngines: MAC_TTS_SAMANTHA_ALEX
  },

  mac_apple_m2: {
    id: 'mac_apple_m2',
    label: 'macOS Sonoma 14 — Apple M2 (MacBook Air 13")',
    category: 'macOS Apple Silicon',
    os: 'macOS',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'arm',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
      wow64: false
    },
    coresOptions: [8, 10],
    memoryOptions: [8, 16, 24],
    minMemoryByCores: { 8: 8, 10: 16 },
    screens: ['1470,956', '2560,1440', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Apple)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '1024',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 511]',
      MAX_SAMPLES: '4',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Apple Inc.',
    productType: 'Mac14,2',
    macPrefix: ['BC', 'D0', '74'],
    disabledFonts: MAC_DISABLED_FONTS,
    ttsEngines: MAC_TTS_SAMANTHA_VICTORIA
  },

  mac_apple_m1: {
    id: 'mac_apple_m1',
    label: 'macOS Ventura 13 — Apple M1 (MacBook Air 13")',
    category: 'macOS Apple Silicon',
    os: 'macOS',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'arm',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '13.6.7',
      wow64: false
    },
    coresOptions: [8],
    memoryOptions: [8, 16],
    minMemoryByCores: { 8: 8 },
    screens: ['1440,900', '1680,1050', '2560,1440'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (Apple)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '1024',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 511]',
      MAX_SAMPLES: '4',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Apple Inc.',
    productType: 'MacBookAir10,1',
    macPrefix: ['3C', '06', '30'],
    disabledFonts: MAC_DISABLED_FONTS,
    ttsEngines: MAC_TTS_SAMANTHA_VICTORIA
  },

  mac_intel_radeon5500m: {
    id: 'mac_intel_radeon5500m',
    label: 'macOS Sonoma 14 (x86_64) — AMD Radeon Pro 5500M (Intel MacBook Pro 16")',
    category: 'macOS Intel x86_64',
    os: 'macOS',
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    uaTemplate: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${KERNEL_MAJOR}.0.0.0 Safari/537.36`,
    uaMetadata: {
      architecture: 'x86',
      bitness: '64',
      FormFactors: ['Desktop'],
      fullVersion: KERNEL_VERSION_FULL,
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.4.1',
      wow64: false
    },
    coresOptions: [12, 16],
    memoryOptions: [16, 32, 64],
    minMemoryByCores: { 12: 16, 16: 32 },
    screens: ['1792,1120', '2560,1440', '1920,1080'],
    webgl: {
      UNMASKED_VENDOR_WEBGL: 'Google Inc. (AMD)',
      UNMASKED_RENDERER_WEBGL: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)',
      VENDOR: 'WebKit',
      RENDERER: 'WebKit WebGL',
      VERSION: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      MAX_TEXTURE_SIZE: '16384',
      MAX_CUBE_MAP_TEXTURE_SIZE: '16384',
      MAX_RENDERBUFFER_SIZE: '16384',
      MAX_VIEWPORT_DIMS: '[16384, 16384]',
      MAX_VERTEX_ATTRIBS: '16',
      MAX_VERTEX_UNIFORM_VECTORS: '1024',
      MAX_FRAGMENT_UNIFORM_VECTORS: '1024',
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: '32',
      MAX_TEXTURE_IMAGE_UNITS: '16',
      MAX_VERTEX_TEXTURE_IMAGE_UNITS: '16',
      ALIASED_LINE_WIDTH_RANGE: '[1, 1]',
      ALIASED_POINT_SIZE_RANGE: '[1, 511]',
      MAX_SAMPLES: '4',
      MAX_TEXTURE_MAX_ANISOTROPY_EXT: '16'
    },
    manufacturer: 'Apple Inc.',
    productType: 'MacBookPro16,1',
    macPrefix: ['AC', 'DE', '48'],
    disabledFonts: MAC_DISABLED_FONTS,
    ttsEngines: MAC_TTS_SAMANTHA_ALEX
  }
};

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function pickRandom(arr) {
  return arr[crypto.randomInt(0, arr.length)];
}

function randomHex(len) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function generateMacAddress(os, customPrefix) {
  // Realistic OUI prefixes per manufacturer / OS
  const prefix = Array.isArray(customPrefix) && customPrefix.length === 3
    ? customPrefix
    : (os === 'macOS' ? ['F0', '18', '98'] : ['00', '1A', '2B']);
  const suffix = [
    randomHex(2).toUpperCase(),
    randomHex(2).toUpperCase(),
    randomHex(2).toUpperCase()
  ];
  return [...prefix, ...suffix].join('-');
}

function generateDeviceName(os, blueprintId) {
  if (os === 'macOS') {
    if (blueprintId && blueprintId.includes('m1')) return `MacBook-Air-${randomHex(4).toUpperCase()}.local`;
    if (blueprintId && blueprintId.includes('m2')) return `MacBook-Air-${randomHex(4).toUpperCase()}.local`;
    return `MacBook-Pro-${randomHex(4).toUpperCase()}.local`;
  }
  if (blueprintId && blueprintId.includes('iris_xe')) {
    return `LAPTOP-${randomHex(7).toUpperCase()}`;
  }
  return `DESKTOP-${randomHex(7).toUpperCase()}`;
}

function generateMediaDevices(os, blueprintId) {
  const groupAudio = randomHex(64);
  const groupVideo = randomHex(64);
  const isLaptop = os === 'macOS' || (blueprintId && blueprintId.includes('iris_xe'));
  return [
    {
      device_id: 'default',
      label: os === 'macOS'
        ? 'Default - MacBook Pro Microphone (Built-in)'
        : 'Default - Microphone (Realtek(R) Audio)',
      group_id: groupAudio,
      device_type: 0 // audioinput
    },
    {
      device_id: randomHex(64),
      label: os === 'macOS'
        ? 'FaceTime HD Camera (Built-in)'
        : (isLaptop ? 'Integrated Webcam (04f2:b6d9)' : 'HD Pro Webcam C920 (046d:082d)'),
      group_id: groupVideo,
      device_type: 2 // videoinput
    },
    {
      device_id: 'default',
      label: os === 'macOS'
        ? 'Default - MacBook Pro Speakers (Built-in)'
        : 'Default - Speakers (Realtek(R) Audio)',
      group_id: groupAudio,
      device_type: 1 // audiooutput
    }
  ];
}

/**
 * Computes compatible RAM options given a blueprint and selected CPU core count.
 * Enforces hardware assembly realism (e.g. a 24-core or 32-core workstation cannot have 8GB RAM,
 * and RTX 4090 / M4 Max builds require >= 32GB RAM).
 *
 * @param {Object} bp - Blueprint object from HARDWARE_BLUEPRINTS
 * @param {number|string} cores - Selected CPU cores
 * @returns {number[]} Compatible memory options in GB
 */
function getCompatibleMemoryOptions(bp, cores) {
  const numCores = Number(cores);
  const minMem = (bp.minMemoryByCores && bp.minMemoryByCores[numCores])
    || (numCores >= 24 ? 32 : numCores >= 12 ? 16 : 8);
  const filtered = bp.memoryOptions.filter((m) => m >= minMem);
  return filtered.length > 0 ? filtered : bp.memoryOptions;
}

/**
 * Computes JsHeapSizeLimit matched to RAM capacity for realistic V8 heap reporting.
 *
 * @param {number|string} deviceMemoryGb
 * @returns {string}
 */
function computeJsHeapSizeLimit(deviceMemoryGb) {
  const mem = Number(deviceMemoryGb);
  if (mem >= 16) return '4294705152';
  return '2172649472';
}

/**
 * Generates a complete, self-consistent profile fingerprint specification.
 * Automatically validates hardware assembly compatibility (CPU <-> RAM <-> GPU <-> Screen).
 *
 * @param {Object} [overrides={}]
 * @returns {Object} Full fingerprint configuration ready for DB storage or ConfigBuilder.
 */
function generateFingerprint(overrides = {}) {
  const blueprintKeys = Object.keys(HARDWARE_BLUEPRINTS);
  const blueprintId = overrides.blueprintId && HARDWARE_BLUEPRINTS[overrides.blueprintId]
    ? overrides.blueprintId
    : pickRandom(blueprintKeys);

  const bp = HARDWARE_BLUEPRINTS[blueprintId];

  // CRITICAL: CanvasMark MUST be >= 1000 (`0x3e8` check at fileOff 82503222 in chrome.dll)
  const canvasMark = String(overrides.canvasMark || randomInt(100000, 99999999));
  // WebGLMark: 1..99 (coordinate selector for readPixels -1 perturbation)
  const webglMark = String(overrides.webglMark || randomInt(2, 95));
  // AudioFP: 1..99 (divided by 1000.0f in OscillatorHandler)
  const audioFp = String(overrides.audioFp || randomInt(5, 85));
  // ClientRectFP: 1..99 (divided by 10000.0 for multi-line inline DOMRect.y)
  const clientRectFp = String(overrides.clientRectFp || randomInt(5, 85));

  // Select or validate CPU cores against blueprint's technical coresOptions
  let coresNum = Number(overrides.hardwareConcurrency);
  if (!coresNum || !bp.coresOptions.includes(coresNum)) {
    coresNum = overrides.hardwareConcurrency ? bp.coresOptions.reduce((prev, curr) =>
      Math.abs(curr - coresNum) < Math.abs(prev - coresNum) ? curr : prev
    ) : pickRandom(bp.coresOptions);
  }
  const hardwareConcurrency = String(coresNum);

  // Select or validate RAM capacity against blueprint + CPU core count rules
  const compatibleMemories = getCompatibleMemoryOptions(bp, coresNum);
  let memNum = Number(overrides.deviceMemory);
  if (!memNum || !compatibleMemories.includes(memNum)) {
    memNum = overrides.deviceMemory ? compatibleMemories.reduce((prev, curr) =>
      Math.abs(curr - memNum) < Math.abs(prev - memNum) ? curr : prev
    ) : pickRandom(compatibleMemories);
  }
  const deviceMemory = String(memNum);

  // Select or validate Screen resolution against blueprint's compatible screens
  const screenSize = (overrides.screenSize && bp.screens.includes(overrides.screenSize))
    ? overrides.screenSize
    : pickRandom(bp.screens);

  const langs = overrides.langs || 'en-US,en';
  const acceptLang = overrides.acceptLang || 'en-US,en;q=0.9';
  const timeZone = overrides.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const userAgent = overrides.userAgent || bp.uaTemplate;
  const deviceName = overrides.deviceName || generateDeviceName(bp.os, bp.id);
  const macAddress = overrides.macAddress || generateMacAddress(bp.os, bp.macPrefix);

  const rawFp = {
    blueprintId: bp.id,
    os: bp.os,
    userAgent,
    switches: {
      HardwareConcurrency: hardwareConcurrency,
      DeviceMemory: deviceMemory,
      Platform: overrides.platform || bp.platform,
      Vendor: overrides.vendor || bp.vendor,
      Langs: langs,
      AcceptLang: acceptLang,
      TimeZone: timeZone,
      ScreenSize: screenSize,
      CanvasMark: canvasMark,
      WebGLMark: webglMark,
      AudioFP: audioFp,
      ClientRectFP: clientRectFp,
      Webgpu: overrides.webgpu || '1',
      EnableDoNotTrack: overrides.enableDoNotTrack || '0',
      AllowScanPorts: overrides.allowScanPorts || '0',
      DisableExtensions: overrides.disableExtensions || '1'
    },
    staticConfig: {
      AutomationControlled: '0',
      ChromeValidation: '0',
      DisableGoogleValidationHeaders: '1',
      NewTabURL: overrides.newTabUrl || 'about:blank',
      DeviceName: deviceName,
      MacAdderss: macAddress, // Matches exact typo in chrome.dll (fileOff 53610037)
      Manufacturer: bp.manufacturer,
      ProductType: bp.productType,
      MaxTouchPoints: '0',
      AudioSession: randomHex(32),
      JsHeapSizeLimit: computeJsHeapSizeLimit(deviceMemory),
      UserAgentMetadata: Object.assign({}, bp.uaMetadata, overrides.uaMetadata || {}),
      MediaDevices: overrides.mediaDevices || generateMediaDevices(bp.os, bp.id),
      TTSEngines: overrides.ttsEngines || bp.ttsEngines,
      DisabledFonts: overrides.disabledFonts || bp.disabledFonts
    },
    dynamicConfig: Object.assign({
      _v: '1',
      TimeZone: timeZone,
      DisableWebRTC: overrides.disableWebRTC || '0',
      WebRTCIceServer: overrides.webRtcIceServer || '1',
      PublicIP: overrides.publicIp || '',
      WebRTCAddress: overrides.webRtcAddress || overrides.publicIp || '',
      Geoposition: overrides.geoposition || ''
    }, overrides.dynamicConfig || {}),
    webglFp: Object.assign({}, bp.webgl, overrides.webglFp || {})
  };

  return validateAndHealFingerprint(rawFp).fp;
}

/**
 * Extracts canonical hardware signature keys from a fingerprint or profile object
 * for cross-profile collision detection.
 *
 * @param {Object} item - Profile object (`{ fingerprint }`) or direct `fingerprint` object
 * @returns {{
 *   blueprintId: string,
 *   hwComboKey: string,
 *   fullHwKey: string,
 *   canvasMark: string,
 *   noiseTupleKey: string,
 *   macAddress: string,
 *   deviceName: string,
 *   audioSession: string
 * }}
 */
function extractHardwareSignature(item) {
  const fp = (item && item.fingerprint) ? item.fingerprint : (item || {});
  const sw = fp.switches || {};
  const st = fp.staticConfig || {};
  const wgl = fp.webglFp || {};

  const blueprintId = fp.blueprintId || '';
  const platform = sw.Platform || '';
  const cores = String(sw.HardwareConcurrency || '');
  const memory = String(sw.DeviceMemory || '');
  const screen = String(sw.ScreenSize || '');
  const renderer = String(wgl.UNMASKED_RENDERER_WEBGL || '');

  // Hardware assembly tuple: Blueprint + CPU Cores + RAM + Screen
  const hwComboKey = `${blueprintId}|${cores}|${memory}|${screen}`;
  // Full hardware signature including renderer & platform
  const fullHwKey = `${platform}|${renderer}|${cores}|${memory}|${screen}`;

  return {
    blueprintId,
    hwComboKey,
    fullHwKey,
    canvasMark: String(sw.CanvasMark || ''),
    noiseTupleKey: `${sw.WebGLMark || ''}|${sw.AudioFP || ''}|${sw.ClientRectFP || ''}`,
    macAddress: String(st.MacAdderss || st.MacAddress || ''),
    deviceName: String(st.DeviceName || ''),
    audioSession: String(st.AudioSession || '')
  };
}

/**
 * Enumerates all technically valid `(blueprintId, hardwareConcurrency, deviceMemory, screenSize)`
 * combinations across all blueprints (or a single requested blueprint).
 *
 * @param {string} [targetBlueprintId]
 * @returns {Array<{ blueprintId: string, hardwareConcurrency: string, deviceMemory: string, screenSize: string, comboKey: string }>}
 */
function listValidHardwareCombinations(targetBlueprintId) {
  const bpIds = (targetBlueprintId && HARDWARE_BLUEPRINTS[targetBlueprintId])
    ? [targetBlueprintId]
    : Object.keys(HARDWARE_BLUEPRINTS);

  const combinations = [];
  for (const bpId of bpIds) {
    const bp = HARDWARE_BLUEPRINTS[bpId];
    for (const cores of bp.coresOptions) {
      const memOptions = getCompatibleMemoryOptions(bp, cores);
      for (const mem of memOptions) {
        for (const scr of bp.screens) {
          const comboKey = `${bpId}|${cores}|${mem}|${scr}`;
          combinations.push({
            blueprintId: bpId,
            hardwareConcurrency: String(cores),
            deviceMemory: String(mem),
            screenSize: scr,
            comboKey
          });
        }
      }
    }
  }
  return combinations;
}

/**
 * Generates a 100% unique, hardware-compatible fingerprint by comparing against all existing
 * profiles in the database (or passed array).
 *
 * Anti-collision guarantees:
 * 1. Prioritizes unused Blueprints first (least-used GPU/Mainboard models).
 * 2. Guarantees a distinct Hardware Assembly Combination (`blueprintId | CPU Cores | RAM | Screen`)
 *    whenever any unused combination remains in the hardware pool (~500+ valid technical combinations).
 * 3. Strictly guarantees zero collision on `CanvasMark`, `WebGLMark|AudioFP|ClientRectFP` noise tuple,
 *    `MacAdderss`, `DeviceName`, and `AudioSession`.
 *
 * @param {Object} [overrides={}] - User overrides (e.g., optional `blueprintId`)
 * @param {Array<Object>} [existingProfiles=[]] - List of existing profiles or fingerprints
 * @returns {Object} Unique fingerprint object
 */
function generateUniqueFingerprint(overrides = {}, existingProfiles = []) {
  const usedBlueprintCounts = {};
  const usedHwCombos = new Set();
  const usedFullHwKeys = new Set();
  const usedCanvasMarks = new Set();
  const usedNoiseTuples = new Set();
  const usedMacAddresses = new Set();
  const usedDeviceNames = new Set();
  const usedAudioSessions = new Set();

  for (const bpId of Object.keys(HARDWARE_BLUEPRINTS)) {
    usedBlueprintCounts[bpId] = 0;
  }

  for (const item of existingProfiles) {
    const sig = extractHardwareSignature(item);
    if (sig.blueprintId && usedBlueprintCounts[sig.blueprintId] !== undefined) {
      usedBlueprintCounts[sig.blueprintId]++;
    }
    if (sig.hwComboKey) usedHwCombos.add(sig.hwComboKey);
    if (sig.fullHwKey) usedFullHwKeys.add(sig.fullHwKey);
    if (sig.canvasMark) usedCanvasMarks.add(sig.canvasMark);
    if (sig.noiseTupleKey) usedNoiseTuples.add(sig.noiseTupleKey);
    if (sig.macAddress) usedMacAddresses.add(sig.macAddress);
    if (sig.deviceName) usedDeviceNames.add(sig.deviceName);
    if (sig.audioSession) usedAudioSessions.add(sig.audioSession);
  }

  // Determine candidate hardware combinations
  const requestedBp = overrides.blueprintId && HARDWARE_BLUEPRINTS[overrides.blueprintId]
    ? overrides.blueprintId
    : null;

  const allValidCombos = listValidHardwareCombinations(requestedBp);
  // Filter to combinations not yet used by any existing profile
  let availableCombos = allValidCombos.filter((c) => !usedHwCombos.has(c.comboKey));

  // If user forced a specific blueprint and all its combos are exhausted, fall back to all blueprints' unused combos
  if (availableCombos.length === 0 && requestedBp) {
    availableCombos = listValidHardwareCombinations(null).filter((c) => !usedHwCombos.has(c.comboKey));
  }

  let chosenCombo = null;
  if (availableCombos.length > 0) {
    // Prioritize blueprints with the lowest usage count so profiles spread across different GPUs/CPUs
    let minUsage = Infinity;
    for (const c of availableCombos) {
      const count = usedBlueprintCounts[c.blueprintId] || 0;
      if (count < minUsage) minUsage = count;
    }
    const leastUsedBpCombos = availableCombos.filter(
      (c) => (usedBlueprintCounts[c.blueprintId] || 0) === minUsage
    );
    chosenCombo = pickRandom(leastUsedBpCombos.length > 0 ? leastUsedBpCombos : availableCombos);
  } else {
    chosenCombo = pickRandom(allValidCombos);
  }

  const bp = HARDWARE_BLUEPRINTS[chosenCombo.blueprintId];

  // Generate guaranteed-unique CanvasMark (>= 100000)
  let canvasMark = overrides.canvasMark ? String(overrides.canvasMark) : String(randomInt(100000, 99999999));
  let guard = 0;
  while ((usedCanvasMarks.has(canvasMark) || Number(canvasMark) < 1000) && guard < 1000) {
    canvasMark = String(randomInt(100000, 99999999));
    guard++;
  }

  // Generate guaranteed-unique Noise Tuple (WebGLMark | AudioFP | ClientRectFP)
  let webglMark = overrides.webglMark ? String(overrides.webglMark) : String(randomInt(2, 95));
  let audioFp = overrides.audioFp ? String(overrides.audioFp) : String(randomInt(5, 85));
  let clientRectFp = overrides.clientRectFp ? String(overrides.clientRectFp) : String(randomInt(5, 85));
  guard = 0;
  while (usedNoiseTuples.has(`${webglMark}|${audioFp}|${clientRectFp}`) && guard < 1000) {
    webglMark = String(randomInt(2, 95));
    audioFp = String(randomInt(5, 85));
    clientRectFp = String(randomInt(5, 85));
    guard++;
  }

  // Generate guaranteed-unique MAC Address
  let macAddress = overrides.macAddress || generateMacAddress(bp.os, bp.macPrefix);
  guard = 0;
  while (usedMacAddresses.has(macAddress) && guard < 500) {
    macAddress = generateMacAddress(bp.os, bp.macPrefix);
    guard++;
  }

  // Generate guaranteed-unique DeviceName
  let deviceName = overrides.deviceName || generateDeviceName(bp.os, bp.id);
  guard = 0;
  while (usedDeviceNames.has(deviceName) && guard < 500) {
    deviceName = generateDeviceName(bp.os, bp.id);
    guard++;
  }

  const mergedOverrides = Object.assign({}, overrides, {
    blueprintId: chosenCombo.blueprintId,
    hardwareConcurrency: overrides.hardwareConcurrency || chosenCombo.hardwareConcurrency,
    deviceMemory: overrides.deviceMemory || chosenCombo.deviceMemory,
    screenSize: overrides.screenSize || chosenCombo.screenSize,
    canvasMark,
    webglMark,
    audioFp,
    clientRectFp,
    macAddress,
    deviceName
  });

  const fp = generateFingerprint(mergedOverrides);

  // Ensure AudioSession is also unique
  guard = 0;
  while (usedAudioSessions.has(fp.staticConfig.AudioSession) && guard < 500) {
    fp.staticConfig.AudioSession = randomHex(32);
    guard++;
  }

  return fp;
}

/**
 * Validates and auto-heals a profile fingerprint before launching Chrome,
 * ensuring technical hardware assembly coherence and preventing all 12 C++ hook failure modes.
 *
 * Technical Hardware Compatibility Checks:
 * 1. CanvasMark >= 1000 (`fileOff 82503222`).
 * 2. AutomationControlled === '0'.
 * 3. HideDebugPanel removed for CDP compatibility.
 * 4. OS / Platform <-> WebGL Renderer / Vendor / Shader & Texture Limits (Direct3D11 on Windows vs Metal on macOS).
 * 5. Apple Silicon (`Apple M1/M2/M3/M4`) <-> ARM64 architecture vs x86_64 on Windows / Intel Mac.
 * 6. Blueprint CPU Cores & RAM compatibility (auto-heals impossible CPU/RAM pairings, e.g. 24 cores with 8GB RAM).
 * 7. JsHeapSizeLimit matched to DeviceMemory (`4294705152` for >= 16GB, `2172649472` for < 16GB).
 * 8. Screen resolution compatibility (prevents Mac Retina aspect ratios like `1728,1117` or `1512,982` on Windows PC).
 * 9. DisabledFonts & TTSEngines OS consistency (blocks Windows Segoe UI on Mac and blocks Apple SF Pro on Windows).
 *
 * @param {Object} fp
 * @returns {{ valid: boolean, warnings: string[], fp: Object }}
 */
function validateAndHealFingerprint(fp) {
  const warnings = [];
  const cloned = JSON.parse(JSON.stringify(fp || {}));

  if (!cloned.switches) cloned.switches = {};
  if (!cloned.staticConfig) cloned.staticConfig = {};
  if (!cloned.dynamicConfig) cloned.dynamicConfig = {};
  if (!cloned.webglFp) cloned.webglFp = {};

  // Resolve target blueprint if valid, otherwise infer from Platform / Renderer
  let bp = cloned.blueprintId && HARDWARE_BLUEPRINTS[cloned.blueprintId]
    ? HARDWARE_BLUEPRINTS[cloned.blueprintId]
    : null;

  const platform = cloned.switches.Platform || (bp ? bp.platform : 'Win32');
  cloned.switches.Platform = platform;

  if (!bp) {
    bp = platform === 'MacIntel'
      ? HARDWARE_BLUEPRINTS.mac_apple_m3_max
      : HARDWARE_BLUEPRINTS.win_nvidia_rtx4090;
    cloned.blueprintId = bp.id;
  }

  // Ensure blueprint matches Platform if Platform was explicitly overridden
  if (platform === 'MacIntel' && bp.platform !== 'MacIntel') {
    warnings.push(`Blueprint ${bp.id} is for Windows but Platform is MacIntel; switched to mac_apple_m3_max.`);
    bp = HARDWARE_BLUEPRINTS.mac_apple_m3_max;
    cloned.blueprintId = bp.id;
  } else if (platform === 'Win32' && bp.platform !== 'Win32') {
    warnings.push(`Blueprint ${bp.id} is for macOS but Platform is Win32; switched to win_nvidia_rtx4090.`);
    bp = HARDWARE_BLUEPRINTS.win_nvidia_rtx4090;
    cloned.blueprintId = bp.id;
  }

  cloned.os = bp.os;

  // 1. CanvasMark threshold check (>= 1000 required by fileOff 82503222)
  const cm = parseInt(cloned.switches.CanvasMark, 10);
  if (isNaN(cm) || cm < 1000) {
    warnings.push(`CanvasMark (${cloned.switches.CanvasMark}) < 1000; auto-adjusted to 125489.`);
    cloned.switches.CanvasMark = '125489';
  }

  // 2. Ensure AutomationControlled is disabled
  if (cloned.staticConfig.AutomationControlled !== '0') {
    warnings.push('AutomationControlled forced to "0" to hide navigator.webdriver.');
    cloned.staticConfig.AutomationControlled = '0';
  }

  // 3. Ensure HideDebugPanel is NOT set if CDP automation might be used
  if (cloned.switches.HideDebugPanel === '1') {
    warnings.push('Removed HideDebugPanel=1 because it blocks CDP /json page targets.');
    delete cloned.switches.HideDebugPanel;
  }

  // 4. Cross-check OS vs Platform vs WebGL Renderer & GPU hardware parameters
  const renderer = cloned.webglFp.UNMASKED_RENDERER_WEBGL || '';
  if (platform === 'MacIntel' && (renderer.includes('Direct3D11') || !renderer)) {
    warnings.push('Platform is MacIntel but WebGL renderer used Direct3D11/empty; healed to Apple Metal.');
    Object.assign(cloned.webglFp, bp.webgl);
  } else if (platform === 'Win32' && (renderer.includes('ANGLE Metal Renderer') || !renderer)) {
    warnings.push('Platform is Win32 but WebGL renderer used Apple Metal/empty; healed to Direct3D11.');
    Object.assign(cloned.webglFp, bp.webgl);
  }

  // 5. Hardware Assembly Check: CPU Cores & RAM Capacity technical compatibility
  let cores = parseInt(cloned.switches.HardwareConcurrency, 10);
  if (isNaN(cores) || !bp.coresOptions.includes(cores)) {
    const healedCores = bp.coresOptions.includes(cores)
      ? cores
      : bp.coresOptions.reduce((prev, curr) =>
          Math.abs(curr - (cores || bp.coresOptions[0])) < Math.abs(prev - (cores || bp.coresOptions[0])) ? curr : prev
        );
    if (!isNaN(cores)) {
      warnings.push(`CPU Cores (${cores}) incompatible with ${bp.label}; healed to ${healedCores} Cores.`);
    }
    cores = healedCores;
    cloned.switches.HardwareConcurrency = String(cores);
  }

  const validRamForCores = getCompatibleMemoryOptions(bp, cores);
  let ram = parseInt(cloned.switches.DeviceMemory, 10);
  if (isNaN(ram) || !validRamForCores.includes(ram)) {
    const healedRam = validRamForCores.reduce((prev, curr) =>
      Math.abs(curr - (ram || validRamForCores[0])) < Math.abs(prev - (ram || validRamForCores[0])) ? curr : prev
    );
    if (!isNaN(ram)) {
      warnings.push(`RAM (${ram}GB) incompatible with ${bp.label} (${cores} Cores); healed to ${healedRam}GB.`);
    }
    ram = healedRam;
    cloned.switches.DeviceMemory = String(ram);
  }

  // Sync JsHeapSizeLimit with healed RAM
  cloned.staticConfig.JsHeapSizeLimit = computeJsHeapSizeLimit(ram);

  // 6. Hardware Assembly Check: Screen Resolution vs OS/FormFactor
  const macExclusiveScreens = ['1728,1117', '1512,982', '1470,956', '1440,900', '1792,1120'];
  const currentScreen = cloned.switches.ScreenSize || '';
  if (platform === 'Win32' && macExclusiveScreens.includes(currentScreen)) {
    const healedScreen = bp.screens[0] || '1920,1080';
    warnings.push(`Screen (${currentScreen}) is an Apple MacBook Retina resolution on Win32; healed to ${healedScreen}.`);
    cloned.switches.ScreenSize = healedScreen;
  } else if (!currentScreen) {
    cloned.switches.ScreenSize = bp.screens[0] || '1920,1080';
  }

  // 7. Hardware Assembly Check: UserAgentMetadata Architecture (ARM64 for Apple M-series vs x86 for Win/Intel)
  if (!cloned.staticConfig.UserAgentMetadata) {
    cloned.staticConfig.UserAgentMetadata = Object.assign({}, bp.uaMetadata);
  } else {
    const activeRenderer = cloned.webglFp.UNMASKED_RENDERER_WEBGL || '';
    if (platform === 'MacIntel' && activeRenderer.includes('Apple M')) {
      cloned.staticConfig.UserAgentMetadata.architecture = 'arm';
      cloned.staticConfig.UserAgentMetadata.platform = 'macOS';
    } else if (platform === 'Win32') {
      cloned.staticConfig.UserAgentMetadata.architecture = 'x86';
      cloned.staticConfig.UserAgentMetadata.platform = 'Windows';
    }
  }

  // 8. Sync Manufacturer, ProductType, DisabledFonts & TTSEngines with OS if missing or mismatched
  if (!cloned.staticConfig.Manufacturer) cloned.staticConfig.Manufacturer = bp.manufacturer;
  if (!cloned.staticConfig.ProductType) cloned.staticConfig.ProductType = bp.productType;
  if (!Array.isArray(cloned.staticConfig.DisabledFonts) || cloned.staticConfig.DisabledFonts.length === 0) {
    cloned.staticConfig.DisabledFonts = bp.disabledFonts;
  }
  if (!Array.isArray(cloned.staticConfig.TTSEngines) || cloned.staticConfig.TTSEngines.length === 0) {
    cloned.staticConfig.TTSEngines = bp.ttsEngines;
  }

  // 9. Sync TimeZone between switches and DynamicConfig
  if (cloned.dynamicConfig.TimeZone && cloned.switches.TimeZone !== cloned.dynamicConfig.TimeZone) {
    cloned.switches.TimeZone = cloned.dynamicConfig.TimeZone;
  } else if (cloned.switches.TimeZone && !cloned.dynamicConfig.TimeZone) {
    cloned.dynamicConfig.TimeZone = cloned.switches.TimeZone;
  }

  // 10. Sync MacAddress -> MacAdderss typo in chrome.dll
  if (cloned.staticConfig.MacAddress && !cloned.staticConfig.MacAdderss) {
    cloned.staticConfig.MacAdderss = cloned.staticConfig.MacAddress;
    delete cloned.staticConfig.MacAddress;
  }

  // 11. Bounds validation for numeric spoof perturbation marks (1..99)
  if (cloned.switches.WebGLMark !== undefined) {
    const wm = parseInt(cloned.switches.WebGLMark, 10);
    if (isNaN(wm) || wm < 1 || wm > 99) cloned.switches.WebGLMark = '45';
  }
  if (cloned.switches.AudioFP !== undefined) {
    const af = parseInt(cloned.switches.AudioFP, 10);
    if (isNaN(af) || af < 1 || af > 99) cloned.switches.AudioFP = '35';
  }
  if (cloned.switches.ClientRectFP !== undefined) {
    const cr = parseInt(cloned.switches.ClientRectFP, 10);
    if (isNaN(cr) || cr < 1 || cr > 99) cloned.switches.ClientRectFP = '42';
  }

  return {
    valid: true,
    warnings,
    fp: cloned
  };
}

module.exports = {
  KERNEL_VERSION_FULL,
  KERNEL_MAJOR,
  HARDWARE_BLUEPRINTS,
  getCompatibleMemoryOptions,
  extractHardwareSignature,
  listValidHardwareCombinations,
  generateFingerprint,
  generateUniqueFingerprint,
  validateAndHealFingerprint
};
