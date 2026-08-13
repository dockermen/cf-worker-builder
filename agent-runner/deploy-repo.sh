#!/bin/bash
# 部署第三方 GitHub Worker 项目到 Cloudflare（由后台执行器 runner 调用）
# 用法: bash deploy-repo.sh <owner/repo> [ref]
# 环境变量: CF_TOKEN / CF_ACCOUNT_ID / CLASH_PROXY(可选，CNB 场景)
set -e
REPO="$1"
REF="${2:-main}"
[ -z "$REPO" ] && { echo "!! 缺少仓库参数"; exit 2; }
echo ">> 执行器环境: Node $(node -v) | npm $(npm -v) | git $(git --version | awk '{print $3}')"

# Clash 代理（CNB 场景）：git/npm/wrangler 走代理；GitHub 直连优先由用户网络决定
if [ -n "$CLASH_PROXY" ]; then
  echo ">> 使用代理: $CLASH_PROXY（git/npm/wrangler）"
  export HTTPS_PROXY=$CLASH_PROXY HTTP_PROXY=$CLASH_PROXY ALL_PROXY=$CLASH_PROXY
  git config --global http.proxy "$CLASH_PROXY"
  git config --global https.proxy "$CLASH_PROXY"
fi
export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

echo "========== [1/6] 克隆仓库 =========="
echo ">> git clone https://github.com/$REPO.git (ref=$REF)"
rm -rf /tmp/deploy-repo
git clone --depth 1 -b "$REF" "https://github.com/$REPO.git" /tmp/deploy-repo || git clone --depth 1 "https://github.com/$REPO.git" /tmp/deploy-repo
cd /tmp/deploy-repo

echo "========== [2/6] 安装依赖 =========="
if [ -f package.json ]; then
  echo ">> npm install"
  npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
else
  echo "  (无 package.json，跳过)"
fi

echo "========== [3/6] 构建（如有 build 脚本） =========="
if [ -f package.json ]; then
  BUILD_SCRIPT=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts.build||'')}catch(e){console.log('')}")
  if [ -n "$BUILD_SCRIPT" ]; then
    echo ">> npm run build"
    npm run build >/dev/null 2>&1 || echo "  !! build 失败（继续尝试部署）"
  fi
fi

echo "========== [4/6] 检查 wrangler 配置 =========="
CONFIG=""
[ -f wrangler.toml ] && CONFIG=wrangler.toml
[ -f wrangler.jsonc ] && CONFIG=wrangler.jsonc
[ -f wrangler.json ] && CONFIG=wrangler.json
if [ -z "$CONFIG" ]; then
  echo "!! 未找到 wrangler 配置（wrangler.toml/jsonc/json），可能不是 Worker 项目"
  exit 2
fi
echo ">> 配置: $CONFIG"

# D1 数据库：database_id 为占位/缺失时自动创建（项目自带 deploy 脚本时由脚本处理）
D1_NAME=$(grep -o '"database_name"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" | head -1 | sed 's/.*: *"//;s/"$//')
D1_ID=$(grep -o '"database_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" | head -1 | sed 's/.*: *"//;s/"$//')
if [ -n "$D1_NAME" ]; then
  if [ -z "$D1_ID" ] || echo "$D1_ID" | grep -qiE 'local-|^[a-f0-9]{8}-'; then
    echo "========== [5/6] 创建 D1 数据库（$D1_NAME） =========="
    npx wrangler d1 create "$D1_NAME" >/tmp/d1-create.log 2>&1 || true
    NEW_ID=$(grep -oE '[a-f0-9]{32}' /tmp/d1-create.log | head -1)
    if [ -n "$NEW_ID" ]; then
      sed -i.bak "s/\"database_id\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"database_id\": \"$NEW_ID\"/" "$CONFIG" 2>/dev/null || true
      echo ">> D1 database_id 已更新: $NEW_ID"
      npx wrangler d1 migrations apply "$D1_NAME" --remote >/dev/null 2>&1 || echo "  (migrations 失败，跳过)"
    else
      echo "  !! D1 创建失败或已存在（日志尾部）："
      tail -3 /tmp/d1-create.log 2>/dev/null || true
    fi
  fi
fi

echo "========== [6/6] 部署 =========="
# 优先使用项目自带 deploy 脚本（如 ternssh 的 npm run deploy），否则直接 wrangler deploy
DEPLOY_SCRIPT=$(node -e "try{const p=require('./package.json');console.log(p.scripts&&p.scripts.deploy||'')}catch(e){console.log('')}")
if [ -n "$DEPLOY_SCRIPT" ] && echo "$DEPLOY_SCRIPT" | grep -q 'wrangler'; then
  echo ">> 使用项目自带部署脚本: npm run deploy"
  npm run deploy 2>&1 | tail -30 || { echo "!! npm run deploy 失败，尝试直接 wrangler deploy"; npx wrangler deploy --config "$CONFIG" 2>&1 | tail -30; }
else
  echo ">> wrangler deploy --config $CONFIG"
  npx wrangler deploy --config "$CONFIG" 2>&1 | tail -30
fi
echo "========== 部署流程结束 =========="
