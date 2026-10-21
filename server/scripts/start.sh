#!/usr/bin/env bash
# 绿天独立服务端后台启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${SERVER_DIR}/.server.pid"
LOG_FILE="${SERVER_DIR}/server.log"

if [ -f "${PID_FILE}" ]; then
    PID=$(cat "${PID_FILE}")
    if ps -p "${PID}" > /dev/null 2>&1; then
        echo "绿天服务端已在运行中 (PID: ${PID})"
        exit 0
    fi
    rm -f "${PID_FILE}"
fi

echo "正在启动绿天服务端..."
cd "${SERVER_DIR}"

# 如果 dist 不存在先编译
if [ ! -d "${SERVER_DIR}/dist" ]; then
    echo "正在编译服务端代码..."
    npx tsc
fi

nohup node "${SERVER_DIR}/dist/index.js" >> "${LOG_FILE}" 2>&1 &
NEW_PID=$!
echo "${NEW_PID}" > "${PID_FILE}"

sleep 1
if ps -p "${NEW_PID}" > /dev/null 2>&1; then
    echo "绿天服务端已成功启动 (PID: ${NEW_PID})，日志输出至: ${LOG_FILE}"
    tail -n 20 "${LOG_FILE}"
else
    echo "启动失败，请检查日志: ${LOG_FILE}"
    cat "${LOG_FILE}"
    exit 1
fi
