# AI-Todo 项目规则

## 部署规则
- 所有改动必须同时适用于电脑端和手机端
- 电脑端：`http://localhost:8088`
- 手机端：`http://192.168.31.102:8088`
- 两者访问同一台服务器、同一套文件，改文件即同步
- 每次部署后执行 `bash deploy.sh` 验证

## 测试规则
- 先确认版本标记（v42 红色角标，右上角）可见 → 确认加载了最新代码
- Service Worker 已禁用，无需清除缓存

## 当前状态 (v42)
- 翻页动画：已全部移除。页面切换为普通无动画切换
- 布局：满屏杂志风格（body 背景 var(--paper) 纸白，无 box-shadow 卡片效果）
- Tab 切换：`function switchTab()` 直接切换 currentTab + render()，无动画
- SW：已注释禁用
- 项目文件：index.html, app.js, sw.js, manifest.json, data.json, deploy.sh
