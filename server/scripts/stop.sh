#!/usr/bin/env bash
# 绿天独立服务端停止脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${SERVER_DIR}/.server.pid"

is_server_process() {
    local pid="$1"
    if [ -z "${pid}" ] || ! ps -p "${pid}" > /dev/null 2>&1; then
        return 1
    fi
    local cmd
    if [ -f "/proc/${pid}/cmdline" ]; then
        cmd=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)
    else
        cmd=$(ps -p "${pid}" -o args= 2>/dev/null || true)
    fi
    if echo "${cmd}" | grep -q "dist/index.js"; then
        return 0
    fi
    return 1
}

if [ ! -f "${PID_FILE}" ]; then
    echo "未找到运行中的服务端进程文件 (${PID_FILE})"
    exit 0
fi

PID=$(cat "${PID_FILE}")
if is_server_process "${PID}"; then
    echo "正在停止绿天服务端 (PID: ${PID})..."
    kill -15 "${PID}" || true
    for i in {1..10}; do
        if ! is_server_process "${PID}"; then
            break
        fi
        sleep 0.5
    done
    if is_server_process "${PID}"; then
        echo "进程未响应，正在强制终止 (SIGKILL)..."
        kill -9 "${PID}" || true
    fi
    echo "绿天服务端已成功停止。"
else
    echo "进程 ${PID} 未在运行或并非绿天服务端进程，已跳过信号发送。"
fi

rm -f "${PID_FILE}"
