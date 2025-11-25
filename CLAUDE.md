# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 工作要求
1. 所有的思考过程、回答、Task文档、Implementation Plan文档以及其他生成的Artifacts必须使用中文编写，即便我是用英文提问
2. 不得在经过我的同意之前，直接开始修改代码
3. 对于我提出的问题，不得在没有了解相关信息的情况下通过猜测和推断回答，可以自行读取文件进行分析后回答
4. 回答我的问题时要有结构化思路，不需要在回复中呈现过多的代码，更多的需要用自然语言说清楚方案逻辑和内容
5. 命令行解释器是git bash，相关工具请使用与git bash兼容的命令行工具

## Project Overview

MDNote is a React Native mobile application for managing markdown notes with cloud synchronization capabilities. It features a timeline-based "flash notes" system, a file browser, and integration with Tencent Cloud Object Storage (COS) for cloud backup and sync.

## Development Commands

### Setup
```bash
# Install dependencies
npm install

# iOS: Install CocoaPods dependencies (first time or after native dep updates)
bundle install
bundle exec pod install
```

### Running the App
```bash
# Start Metro bundler
npm start

# Run on Android
npm run android

# Run on iOS
npm run ios
```

### Development
```bash
# Run linter
npm run lint

# Run tests
npm test
```

## Architecture Overview

### Navigation Structure
- **Root Navigator** (`AppNavigator`): Native Stack Navigator
  - `MainTabs`: Bottom Tab Navigator (Timeline, Browser, Settings)
  - `Editor`: Full-screen editor for viewing/editing markdown files

### State Management (Zustand)
The app uses Zustand stores with AsyncStorage persistence:

1. **`useSettingsStore`** (`src/store/useSettingsStore.ts`)
   - Theme settings
   - Tencent COS configuration (bucket, region)
   - Flash note configuration (path, filename)
   - Note: Credentials (secretId/secretKey) are stored separately in react-native-keychain for security

2. **`useSyncStore`** (`src/store/useSyncStore.ts`)
   - Upload queue for cloud synchronization
   - Queue item status tracking (pending, uploading, failed, success)
   - Retry count management

3. **`useFileMetadataStore`** (`src/store/useFileMetadataStore.ts`)
   - Stores etags and lastModified timestamps for files
   - Used for conflict detection during sync

### Core Services

#### File System Service (`src/services/FileSystemService.ts`)
- Wraps react-native-fs for local file operations
- Root path: `RNFS.DocumentDirectoryPath`
- Provides: listFiles, readFile, writeFile, createDirectory, deleteFile, moveFile, exists, stat

#### Cloud Service (`src/services/CloudService.ts`)
- Abstract interface for cloud storage providers (`ICloudProvider`)
- Currently implements: `TencentCOSProvider`
- Provider is set at app initialization based on settings
- Operations: uploadFile, downloadFile, getCloudFileContent, listFiles, deleteFile, headFile

### Upload Flow

1. **Initialization** (App.tsx):
   - On app start, checks for valid COS config and credentials
   - If found, initializes TencentCOSProvider and sets it on cloudService

2. **Write Flow**:
   - User saves file → Local write → Direct upload to cloud
   - Upload success: Update local metadata (etag, lastModified)
   - Upload failure: Log error (TODO: Add to retry queue)
   - Upload result (etag, lastModified) stored in FileMetadataStore

3. **Conflict Detection**:
   - EditorScreen and TimelineScreen check sync status on load
   - Compares local etag with cloud etag via `headFile()`
   - If mismatch: determines cloudNewer vs localNewer by comparing timestamps
   - User can choose to: use cloud version, keep local, or upload local (force)

### Flash Notes Feature

Flash notes are timestamped markdown entries stored in a single file (default: `flash_notes.md`).

**Format**:
```markdown
## 2025-01-19 14:30:00
Note content here

## 2025-01-18 10:15:00
Another note
```

**Implementation**:
- `TimelineScreen`: Parses flash note file, displays in reverse chronological order
- `FlashNoteInputModal`: Modal component for adding/editing individual flash notes
- File path is configurable via Settings (flashNoteConfig.path + flashNoteConfig.filename)

### Internationalization (i18n)

- Uses i18next with react-i18next
- Translations in: `src/locales/en.json`, `src/locales/zh.json`
- Default language: Chinese (`zh`), fallback: English (`en`)
- Initialized in `src/i18n.ts`, imported at top of `App.tsx`

### Theming

- Centralized theme in `src/utils/theme.ts`
- Currently uses light theme colors
- Theme mode setting exists in SettingsStore but dark mode not fully implemented

## Key Technical Patterns

### Security Considerations
- **Never commit credentials**: COS secretId/secretKey are stored in react-native-keychain (encrypted storage)
- Settings store only contains non-sensitive config (bucket, region)
- When implementing new cloud providers, follow the same pattern

### File Paths
- All file paths in the app are relative to `DocumentDirectoryPath`
- Cloud keys typically match file paths to maintain directory structure
- Use `filePath` as-is for cloud keys to preserve hierarchy

### TypeScript Types
- Navigation types: `src/types/navigation.ts` (RootStackParamList, MainTabParamList)
- Service interfaces: Defined in respective service files
- File/Cloud item types: `FileItem`, `CloudFileItem`

## Common Development Tasks

When adding features that involve file operations:
1. Use `fsService` for all local file operations (never use RNFS directly)
2. For cloud operations, check `cloudService.isConfigured()` first
3. Update FileMetadataStore with etag/lastModified after successful uploads
4. Consider sync conflicts - implement conflict detection if reading cloud files

When adding new screens:
1. Define route params in `src/types/navigation.ts`
2. Add screen to appropriate navigator (AppNavigator or TabNavigator)
3. Use `useTranslation()` hook for all user-facing strings
4. Follow existing screen patterns for sync status indicators

When modifying stores:
1. All stores use Zustand with persist middleware
2. Test that persistence works after changes (clear app data and reload)
3. For sensitive data, use react-native-keychain instead of AsyncStorage
