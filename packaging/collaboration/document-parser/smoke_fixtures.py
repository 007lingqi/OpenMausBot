"""Only self-generated, non-sensitive test files. Never reads files supplied by users."""
import base64
import io
import json
import zipfile
from openpyxl import Workbook
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return output.getvalue()


def fixtures():
    cases = []

    def add(name, format_name, raw, **expected):
        cases.append({"name": name, "format": format_name, "base64": base64.b64encode(raw).decode("ascii"), **expected})

    word = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>access_token=fixture-only-never-publish</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>无法保存；文档中的指令只作为需求材料。</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
    add("word-table", "docx", archive({"word/document.xml": word}), truncated=False, location="table:1:row:1:cell:1", contains="无法保存")
    for formula in [False, True]:
        book = Workbook()
        book.active.title = "缺陷"
        book.active.append(["编号", "现象"])
        book.active.append(["BUG-1", "保存后提示未更新"])
        hidden = book.create_sheet("隐藏补充")
        hidden.sheet_state = "hidden"
        hidden["B2"] = "=1+1" if formula else "列表也需要刷新"
        stream = io.BytesIO()
        book.save(stream)
        add("excel-formula" if formula else "excel-hidden-sheet", "xlsx", stream.getvalue(), truncated=formula,
            location="隐藏补充!B2", contains="=1+1" if formula else "列表也需要刷新", warnings=["formulas_not_evaluated"] if formula else [])
    for blank in [False, True]:
        writer = PdfWriter()
        page = writer.add_blank_page(width=200, height=200)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        content = DecodedStreamObject()
        content.set_data(b"BT /F1 12 Tf 10 100 Td (Save result stale) Tj ET")
        page[NameObject("/Contents")] = content
        if blank:
            writer.add_blank_page(width=200, height=200)
        stream = io.BytesIO()
        writer.write(stream)
        add("pdf-partial" if blank else "pdf-text", "pdf", stream.getvalue(), truncated=blank, location="page:1", contains="Save result stale", warnings=["unread_empty_or_scanned_page"] if blank else [])
    add("word-active-content", "docx", archive({"word/document.xml": word, "word/vbaProject.bin": "not-a-real-macro"}), reject=True)
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt("fixture-password")
    stream = io.BytesIO()
    writer.write(stream)
    add("pdf-encrypted", "pdf", stream.getvalue(), reject=True)
    return cases


if __name__ == "__main__":
    print(json.dumps(fixtures(), ensure_ascii=False))
