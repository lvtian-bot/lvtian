#!/usr/bin/env bash
# 绿天独立服务端后台启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${SERVER_DIR}/.server.pid"
LOG_FILE="${SERVER_DIR}/server.log"

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
    # 严格匹配当前服务端的绝对入口文件路径，防止仅凭通用的 "dist/index.js" 误伤其他 Node 进程
    if echo "${cmd}" | grep -F -q "${SERVER_DIR}/dist/index.js"; then
        return 0
    fi
    # 兼容在 SERVER_DIR 目录下相对路径启动的同实例进程
    if [ -d "/proc/${pid}" ] && [ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null)" = "${SERVER_DIR}" ]; then
        if echo "${cmd}" | grep -E -q "(^|[[:space:]])(\./)?dist/index\.js([[:space:]]|$)"; then
            return 0
        fi
    fi
    return 1
}

if [ -f "${PID_FILE}" ]; then
    PID=$(cat "${PID_FILE}")
    if is_server_process "${PID}"; then
        echo "绿天服务端已在运行中 (PID: ${PID})"
        exit 0
    fi
    echo "检测到陈旧的 PID 文件 (${PID_FILE})，其进程未运行或已非绿天服务端，正在清理..."
    rm -f "${PID_FILE}"
fi

echo "正在启动绿天服务端..."
cd "${SERVER_DIR}"

# 启动前编译服务端代码，确保产物与最新源码严格一致
echo "正在编译服务端代码..."
npx tsc

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
