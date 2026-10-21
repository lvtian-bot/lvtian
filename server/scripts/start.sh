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

    local target="${SERVER_DIR}/dist/index.js"

    # 在 Linux 环境下按 NUL 字符边界严格逐项比对完整 argv 参数，杜绝子串包含误判
    if [ -f "/proc/${pid}/cmdline" ]; then
        while IFS= read -r -d '' arg; do
            if [ "${arg}" = "${target}" ]; then
                return 0
            fi
            # 兼容在 SERVER_DIR 目录下相对路径启动的同实例进程
            if [ -d "/proc/${pid}" ] && [ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null)" = "${SERVER_DIR}" ]; then
                if [ "${arg}" = "dist/index.js" ] || [ "${arg}" = "./dist/index.js" ]; then
                    return 0
                fi
            fi
        done < "/proc/${pid}/cmdline"
        return 1
    else
        # 非 Linux 系统兜底逐项比对
        for arg in $(ps -p "${pid}" -o args= 2>/dev/null); do
            if [ "${arg}" = "${target}" ] || [ "${arg}" = "dist/index.js" ] || [ "${arg}" = "./dist/index.js" ]; then
                return 0
            fi
        done
        return 1
    fi
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
