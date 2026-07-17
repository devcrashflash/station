const HTML_COMMENTS_ONLY = /^(?:\s*<!--[\s\S]*?-->\s*)+$/;

function removeHtmlComments(node) {
  if (!Array.isArray(node?.children)) return;

  node.children = node.children.filter((child) => {
    if (child.type === "html" && HTML_COMMENTS_ONLY.test(child.value)) {
      return false;
    }

    removeHtmlComments(child);
    return true;
  });
}

export function remarkHideHtmlComments() {
  return removeHtmlComments;
}
