import { useCallback, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { googleCalendarConnector, type ConnectorConnection } from '../services/GoogleCalendarConnectorService';
import { useAssistantStore } from '../store/useAssistantStore';

type Snapshot = Awaited<ReturnType<typeof googleCalendarConnector.getStatus>>;
type Operation = 'refresh' | 'connect' | 'disconnect';
type Failure = 'statusFailed' | 'connectFailed' | 'browserFailed' | 'disconnectFailed';
type Availability = 'loading' | 'offline' | 'ready';
const AUTHORIZATION_REFRESH_MS = 3000;

interface ConnectorView {
    availability: Availability;
    snapshot?: Snapshot;
    busy?: Operation;
    failure?: Failure;
    refresh?: () => void;
    connect?: () => void;
    disconnect?: () => void;
}

interface Scope {
    connection: ConnectorConnection;
    snapshot?: Snapshot;
    pending?: { operation: Operation; controller: AbortController };
    failure?: Failure;
    timer?: ReturnType<typeof setTimeout>;
}

const loading: ConnectorView = { availability: 'loading' };

export function useGoogleCalendarConnector(): ConnectorView {
    const [view, setView] = useState<ConnectorView>(loading);

    useFocusEffect(useCallback(() => {
        let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
        let current: Scope | undefined;

        const clearTimer = (scope: Scope) => {
            if (scope.timer !== undefined) clearTimeout(scope.timer);
            scope.timer = undefined;
        };

        const invalidate = () => {
            if (!current) return;
            clearTimer(current);
            current.pending?.controller.abort();
            current = undefined;
        };

        const publish = (scope: Scope) => {
            const snapshot = scope.snapshot;
            setView({
                availability: 'ready', snapshot, busy: scope.pending?.operation, failure: scope.failure,
                refresh: () => { run(scope, 'refresh', { manual: true }); },
                // These callbacks capture the verified account and scope. A confirmation
                // opened before a server/account change cannot affect the new account.
                connect: snapshot && (() => { run(scope, 'connect', { snapshot }); }),
                disconnect: snapshot && (() => { run(scope, 'disconnect', { snapshot }); }),
            });
        };

        async function run(scope: Scope, operation: Operation, options: { snapshot?: Snapshot; manual?: boolean } = {}) {
            if (scope !== current || !active) return;
            const expected = options.snapshot;
            if (expected && (scope.snapshot?.status !== expected.status || scope.snapshot?.account !== expected.account)) return;
            if (scope.pending) {
                if (operation === 'refresh' || scope.pending.operation !== 'refresh') return;
                scope.pending.controller.abort();
            }
            clearTimer(scope);
            const pending = { operation, controller: new AbortController() };
            scope.pending = pending;
            const signal = pending.controller.signal;
            const isCurrent = () => scope === current && scope.pending === pending;
            if (options.manual || operation !== 'refresh') scope.failure = undefined;
            publish(scope);

            let reconcile = operation === 'connect';
            try {
                if (operation === 'connect') {
                    const url = await googleCalendarConnector.connect(scope.connection, signal);
                    if (!isCurrent()) return;
                    if (!active) {
                        scope.failure = 'browserFailed';
                    } else {
                        try { await Linking.openURL(url); }
                        catch { if (isCurrent()) scope.failure = 'browserFailed'; }
                    }
                } else {
                    const snapshot = await (operation === 'refresh'
                        ? googleCalendarConnector.getStatus(scope.connection, signal)
                        : googleCalendarConnector.disconnect(scope.connection, signal));
                    if (!isCurrent()) return;
                    scope.snapshot = snapshot;
                    if (scope.failure === 'statusFailed') scope.failure = undefined;
                }
            } catch {
                if (!isCurrent()) return;
                scope.snapshot = undefined;
                if (operation === 'refresh') scope.failure ??= 'statusFailed';
                else {
                    scope.failure = operation === 'connect' ? 'connectFailed' : 'disconnectFailed';
                    reconcile = true;
                }
            } finally {
                if (isCurrent()) {
                    scope.pending = undefined;
                    if (reconcile) {
                        // Opening the browser or getting a failed POST does not prove
                        // whether authorization was started, completed, or disconnected.
                        scope.snapshot = undefined;
                    }
                    publish(scope);
                    if (active && reconcile) run(scope, 'refresh');
                    else if (active && scope.snapshot?.status === 'authorizing') {
                        scope.timer = setTimeout(() => { run(scope, 'refresh'); }, AUTHORIZATION_REFRESH_MS);
                    }
                }
            }
        }

        const updateConnection = (state: ReturnType<typeof useAssistantStore.getState>) => {
            invalidate();
            if (state.credentialsStatus !== 'ready' || !state.serverUrl || !state.serverToken
                || state.connectionState !== 'connected') {
                setView(state.credentialsStatus === 'loading' ? loading : { availability: 'offline' });
                return;
            }
            current = { connection: { serverUrl: state.serverUrl, serverToken: state.serverToken } };
            setView(loading);
            run(current, 'refresh');
        };

        const unsubscribe = useAssistantStore.subscribe((next, prev) => {
            if (next.serverUrl !== prev.serverUrl || next.serverToken !== prev.serverToken
                || next.credentialsStatus !== prev.credentialsStatus || next.connectionState !== prev.connectionState) {
                updateConnection(next);
            }
        });
        const onAppState = AppState.addEventListener('change', (state) => {
            const wasActive = active;
            active = state === 'active';
            if (!current || wasActive === active) return;
            if (active) {
                run(current, 'refresh');
            } else {
                clearTimer(current);
                if (current.pending?.operation === 'refresh') {
                    current.pending.controller.abort();
                    current.pending = undefined;
                }
                // Always recheck before offering actions after browsing/backgrounding.
                current.snapshot = undefined;
                publish(current);
            }
        });
        updateConnection(useAssistantStore.getState());

        return () => {
            onAppState.remove();
            unsubscribe();
            invalidate();
            setView(loading);
        };
    }, []));

    return view;
}
