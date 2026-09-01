Jacky Image · 座套生成完整角度提示词模板

每个 .txt 文件现在都是对应角度发送给生图模型的完整提示词模板，不再从其他角度 TXT 拼接“摄影机位与构图”内容。
“【摄影机位与构图】”下面已经直接写入该角度的专用规则，可直接修改。

动态内容使用 {{变量名}}：
- {{vehicle.model}}：车辆型号
- {{vehicle.year}}：车辆年份
- {{vehicle.trim}}：车辆配置
- {{vehicle.identity}}：完整车型身份
- {{angle.name}}：当前角度名称
- {{angle.seat_scope}}：前排/后排范围
- {{references.count}}：原车参考图数量
- {{references.vehicle_range}}：参考图编号范围
- {{references.list}}：参考图列表
- {{references.guide_label}}：角度结构引导图编号（当前为 Image 1）
- {{provider.role_delivery}}：当前模型的图片角色总说明，只在【输入图片】开头使用一次，不能代替图片编号
- {{search.instructions}}：联网搜索规则，未开启时为空
- {{user.extra_prompt}}：用户额外要求

模板注释使用 {{! 注释内容 }}，生成前会自动删除，不会发送给模型。
修改保存后，下一次生成或重新生成会立即读取，不需要重新编译软件。

桌面版实际使用目录：
%APPDATA%\Jacky Image\prompts\seat-cover-angles

旧版只有一小段“角度专用规则”的用户文件会在软件启动时自动迁移成完整模板：
- 原来的角度规则会直接放入“【摄影机位与构图】”区域；
- 原文件会保留为同目录下的 .legacy.bak 备份；
- 已经是完整模板的文件不会被覆盖。
