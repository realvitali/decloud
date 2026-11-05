"""Shared PDF section boundaries for reading and whole-book audio."""


def pdf_sections_from_document(doc, fallback_title):
    sections = [{'start': entry[2] - 1, 'title': entry[1].strip(), 'level': entry[0]}
                for entry in doc.get_toc()
                if entry[0] <= 2 and entry[1].strip() and 1 <= entry[2] <= len(doc)]
    if not sections and len(doc):
        sections = [{'start': 0, 'title': fallback_title, 'level': 1}]
    for i, section in enumerate(sections):
        section['end'] = sections[i + 1]['start'] - 1 if i + 1 < len(sections) else len(doc) - 1
    return sections
