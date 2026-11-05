#!/bin/bash
# MySQL 容器首次初始化时执行：给端到端测试建一个单独的库 <DB_NAME>_test，并授权给应用账号。
# 测试会清空这个库，所以绝不和开发库共用。
set -euo pipefail
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}_test\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}_test\`.* TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
SQL
