// Platform smoke configuration for pi-oracle.
// Crabbox is used as the local cross-platform release/readiness gate.

export default {
  packageName: "pi-oracle",
  artifactRoot: ".artifacts/platform-smoke",
  requiredTargets: ["macos", "ubuntu", "windows-native"],
  requiredSuites: ["platform-build", "real-extension"],
  workflows: {
    everyday: {
      description: "Fast local validation for normal iteration.",
      commands: ["npm run verify:oracle"],
    },
    platformSensitive: {
      description: "Doctor plus focused platform target/suite runs for platform-sensitive changes.",
      commands: [
        "npm run smoke:platform:doctor",
        "node scripts/platform-smoke.mjs run --target <target> --suite <suite>",
      ],
    },
    platformMatrix: {
      description: "Doctor-first packed-install macOS/Ubuntu/Windows platform proof.",
      commands: ["npm run smoke:platform:all"],
    },
    release: {
      description: "Full release gate: local verification plus the doctor-first platform matrix.",
      commands: ["npm run release:check"],
    },
  },
  requiredCrabbox: {
    source: "https://github.com/openclaw/crabbox",
    minVersion: "0.26.0",
  },
  ubuntuContainerImage: "pi-oracle-platform-smoke:node24",
  ubuntuContainerBaseImage: "cimg/node:24.16",
  windowsParallels: {
    sourceVm: "pi-extension-windows-template",
    snapshot: "crabbox-ready",
  },
  nodeValidationMajor: 24,
  realSmoke: {
    defaultProvider: "zai",
    defaultModel: "glm-5.1",
    authEnvByProvider: {
      zai: ["ZAI_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
      google: ["GEMINI_API_KEY"],
      xai: ["XAI_API_KEY"],
      groq: ["GROQ_API_KEY"],
      deepseek: ["DEEPSEEK_API_KEY"],
      cerebras: ["CEREBRAS_API_KEY"],
      fireworks: ["FIREWORKS_API_KEY"],
      together: ["TOGETHER_API_KEY"],
      openrouter: ["OPENROUTER_API_KEY"],
      ai_gateway: ["AI_GATEWAY_API_KEY"],
      mistral: ["MISTRAL_API_KEY"],
      minimax: ["MINIMAX_API_KEY"],
      moonshot: ["MOONSHOT_API_KEY"],
      kimi: ["KIMI_API_KEY"],
    },
  },
};
