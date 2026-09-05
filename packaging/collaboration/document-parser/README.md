# 隔离文档正文解析器

此目录实现 DOCX、XLSX、PDF 的只读文本提取。不是 OCR，不执行公式、字段、宏、嵌入对象或文档中的指令；未读取内容以 `truncated` 和 warnings 明确报告，空白/扫描文档不能视为完整读取。

输入通过 stdin 传入，输出仅为带位置的 JSON。Word 记录 XML part/表格/行/单元格/段落，文本框段落不重复；Excel 记录 sheet/cell，PDF 记录页码。原文仍是不可信需求材料；主服务负责脱敏、哈希、账本来源验证和完整性门禁。

## 构建与验证

需要可访问公开镜像站和 PyPI 的非生产 Docker 主机。先取得并核对 Python 3.13 slim 基础镜像的固定 digest，再设置 `PYTHON_BASE` 为完整的 `python:3.13-slim@sha256:…`，不能将文档内容用作构建参数。

```sh
docker build --build-arg PYTHON_BASE="$PYTHON_BASE" --target runtime -t omb-document-parser:local .
docker build --build-arg PYTHON_BASE="$PYTHON_BASE" --target parser-tests -t omb-document-parser-tests:local .
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --log-driver none --user 65534:65534 --memory 384m --memory-swap 384m --cpus 1 --pids-limit 32 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m omb-document-parser-tests:local
docker image inspect omb-document-parser:local --format '{{.Id}}'
```

依赖版本与 PyPI wheel SHA256 全部固定在 requirements.lock；禁止安装未列明的源码包。构建阶段可联网，运行阶段必须无网络、无宿主挂载、非 root、只读并限制资源。运行镜像不包含测试代码。

生产适配器 `DockerDocumentExtractor` 只接受最终镜像的固定 ID/digest；通过 stdin 传入文件，超时/失败后清理本次容器。`configuredDocumentExtractor` 尚未接入 headless 工厂，不应仅设置环境变量便宣称功能已上线。需要完成真实容器参数检查、正文摄取/恢复、来源追踪、失败清理及钉钉试点后才启用。

## 生产适配器容器验证

构建两个镜像后，分别查询实际的完整 `sha256:` 镜像 ID。以下命令从仓库根目录运行；三个变量必须由操作者设置，不能来自附件内容。context 必须指向非生产 Docker，两个镜像必须已缓存，不接受可变标签或隐式默认 context。

```sh
OMB_DOCUMENT_SMOKE_CONTEXT="$PILOT_CONTEXT" \
OMB_DOCUMENT_SMOKE_IMAGE="$PARSER_IMAGE_ID" \
OMB_DOCUMENT_SMOKE_TEST_IMAGE="$PARSER_TEST_IMAGE_ID" \
node --experimental-strip-types server/collaboration/operations/document-extractor.smoke.ts
```

验证程序在受限测试镜像内执行 Python 测试、生成七份内存夹具，再通过生产 `DockerDocumentExtractor` 验证 Word 表格、隐藏 Excel 页、未求值公式、PDF 页来源/空白页不完整提示、活动内容与加密 PDF 拒绝，并单独验证超时清理。每个容器启动前检查实际 image/user/network/挂载/资源限制；拒绝须有进程退出码 2、无 OOM/启动错误及固定错误 JSON，不能用通用异常冒充。超时须同时观察 CLI 超时和该容器仍在运行，随后确认其被适配器移除。

清理逐个检查容器确已消失；最终补偿清理不能掩盖适配器漏清理。创建前保存本次随机名称，覆盖创建回执丢失；只查找/删除本次名称或已确认 ID，一个清理失败仍尝试其余容器。Docker 无法查询、进程强制终止或创建迟到超出查询窗口时，不能保证没有遗留容器，也不会给出通过报告；运行器不是持久恢复 supervisor。

成功只输出镜像 ID、场景和证据来源，不输出文档正文。注入受控 Docker 端口的测试报告明确标为 `controlled_docker_port`，不等同于 CLI 的 `docker` 证据。两者均不证明钉钉正文摄取、Ledger 重启恢复或在线文档权限。

## 验证边界

截至 2026-09-05，已有自生成夹具的本地 Python 测试与 TypeScript Docker 命令端口测试。Colima 下载基础镜像遇 DNS 超时，宿主机镜像清单请求及备用 GitHub 运行时下载也未成功，因此尚无本目录镜像构建或 Linux 运行证据。

2026-09-06：新增上述可重复容器验证入口及故障注入测试。本地 Python 13 项通过；官方 Docker Hub 清单 EOF、Colima 拉取 DNS 超时，备用公开入口 public.ecr.aws 的宿主机 DNS 检查同样超时。没有修改 DNS/代理、借用凭据或重复拉取。真实镜像构建和本验证程序的 Docker 执行仍未完成，不能启用真实附件处理或宣称六类试点通过。

本地测试只可使用自生成的可信夹具，不是处理真实附件的宿主机降级方案。真实用户文件必须走已经验证的受限容器。长文档分段语义覆盖、扫描页 OCR、在线钉钉文档权限和六类真实协作试点均不由这里的单元测试证明。
