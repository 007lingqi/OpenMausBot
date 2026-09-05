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

## 验证边界

截至 2026-09-05，已有自生成夹具的本地 Python 测试与 TypeScript Docker 命令端口测试。Colima 下载基础镜像遇 DNS 超时，宿主机镜像清单请求及备用 GitHub 运行时下载也未成功，因此尚无本目录镜像构建或 Linux 运行证据。

本地测试只可使用自生成的可信夹具，不是处理真实附件的宿主机降级方案。真实用户文件必须走已经验证的受限容器。长文档分段语义覆盖、扫描页 OCR、在线钉钉文档权限和六类真实协作试点均不由这里的单元测试证明。
