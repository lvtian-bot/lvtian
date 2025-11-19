# Project Overview

This is a React Native application named "MDNote", designed as a cloud-first, local-accelerated Markdown note-taking app. It allows users to read and write notes directly from a cloud storage provider, with a focus on Tencent Cloud Object Storage (COS).

## 工作方式
1. 请一律使用中文回复问题，即便我是用英文提问
2. 不得在经过我的同意之前，直接开始修改代码
3. 对于我提出的问题，不得在没有了解相关信息的情况下通过猜测和推断回答，可以自行读取文件进行分析后回答
4. 回答我的问题时要有结构化思路，不需要在回复中呈现过多的代码，更多的需要用自然语言说清楚方案逻辑和内容
5. 命令行解释器是git bash，相关工具请使用与git bash兼容的命令行工具

## Building and Running

### Prerequisites

- Node.js (LTS v20+)
- JDK 17
- Android Studio and Android SDK
- Git

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Running the App

1. **Start Metro:**
   ```bash
   npm start
   ```

2. **Run on Android:**
   ```bash
   npm run android
   ```

3. **Run on iOS:**
   ```bash
   npm run ios
   ```
   (Requires a macOS environment with Xcode and CocoaPods)

### Testing

Run unit tests with:
```bash
npm test
```

### Linting

Check for code style issues with:
```bash
npm run lint
```

## Development Conventions

- **Language:** TypeScript 5.x (strict mode)
- **Framework:** React Native 0.82.1 (Bare Workflow)
- **State Management:** Zustand or React Context (Redux is not used)
- **Navigation:** React Navigation (Native Stack + Bottom Tabs)
- **Cloud Integration:** The app uses a strategy pattern to support multiple cloud providers, with Tencent COS as the primary implementation.
- **Security:** Cloud credentials (SecretId/Key) must be stored securely using `react-native-keychain`, not in plain text.
- **Scripts:** The project provides both PowerShell (`.ps1`) and Bash (`.sh`) scripts for setup.

## Project Structure

- `src/`: Main source code directory.
  - `components/`: Reusable components.
  - `navigation/`: Navigation logic (React Navigation).
  - `screens/`: Application screens.
  - `services/`: Cloud services, file system services, etc.
  - `store/`: State management (Zustand).
  - `types/`: TypeScript type definitions.
  - `utils/`: Utility functions.
- `android/`: Android-specific code and configuration.
- `ios/`: iOS-specific code and configuration.
- `PRD.md`: Detailed product requirements and technical specifications.
