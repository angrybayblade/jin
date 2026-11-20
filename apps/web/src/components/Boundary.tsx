"use client";
import { Component, type ReactNode } from "react";
import { ErrorView } from "./ErrorView";

/**
 * Keeps a panel's failure inside the panel: the rest of the page stays usable, and "Try again"
 * draws the panel afresh. `resetKey` changing (another task, another tab) clears it too.
 */
export class Boundary extends Component<{ label: string; children: ReactNode; resetKey?: unknown }, { error: unknown; key: unknown }> {
  state = { error: null as unknown, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: unknown; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown) {
    console.error(`${this.props.label} failed:`, error);
  }

  render() {
    if (this.state.error) return <ErrorView compact title={`${this.props.label} failed to show`} error={this.state.error} retry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
