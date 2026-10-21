#!/usr/bin/env bash
# 绿天独立服务端停止脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${SERVER_DIR}/.server.pid"

if [ ! -f "${PID_FILE}" ]; then
    echo "未找到运行中的服务端进程文件 (${PID_FILE})"
    exit 0
fi

PID=$(cat "${PID_FILE}")
if ps -p "${PID}" > /dev/null 2>&1; then
    echo "正在停止绿天服务端 (PID: ${PID})..."
    kill -15 "${PID}" || true
    for i in {1..10}; do
        if ! ps -p "${PID}" > /dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done
    if ps -p "${PID}" > /dev/null 2>&1; then
        echo "进程未响应，正在强制终止 (SIGKILL)..."
        kill -9 "${PID}" || true
    fi
    echo "绿天服务端已成功停止。"
else
    echo "进程 ${PID} 未在运行。"
fi

rm -f "${PID_FILE}"
