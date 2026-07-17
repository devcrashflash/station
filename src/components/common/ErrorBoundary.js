import { Component } from "react";

function resetKeysChanged(previousKeys, nextKeys) {
  if (previousKeys.length !== nextKeys.length) return true;
  return previousKeys.some((key, index) => !Object.is(key, nextKeys[index]));
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("A React view failed to render.", error, info);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(previousProps) {
    if (
      this.state.error &&
      resetKeysChanged(previousProps.resetKeys || [], this.props.resetKeys || [])
    ) {
      this.reset();
    }
  }

  reset() {
    this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback({ error: this.state.error, reset: this.reset });
      }
      return this.props.fallback || null;
    }

    return this.props.children;
  }
}
