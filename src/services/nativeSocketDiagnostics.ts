import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { ConnectionEventDetails } from './connectionDiagnostics';

interface SocketDiagnosticsModule {
    track(socketId: number): boolean;
    snapshot(socketId: number): Pick<ConnectionEventDetails, 'nativeSyncAtMs' | 'nativeSyncChars'> | null;
    stop(socketId: number): void;
}

export function trackSocketReceive(ws: WebSocket) {
    if (Platform.OS !== 'android') return undefined;
    // React Native owns the socket and its ID. Older builds continue with JS logs.
    const socketId = (ws as WebSocket & { _socketId?: number })._socketId;
    if (typeof socketId !== 'number') return undefined;
    try {
        const native = requireOptionalNativeModule<SocketDiagnosticsModule>('LvtianSocketDiagnostics');
        if (!native?.track(socketId)) return undefined;
        return {
            snapshot(): ConnectionEventDetails {
                try {
                    return { nativeObserved: true, ...native.snapshot(socketId) };
                } catch {
                    return { nativeObserved: false };
                }
            },
            stop() {
                try { native.stop(socketId); } catch { /* Observability must not affect connection cleanup. */ }
            },
        };
    } catch {
        return undefined;
    }
}
