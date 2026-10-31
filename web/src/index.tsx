import { render } from "solid-js/web";
import { Navigate, Route, Router } from "@solidjs/router";
import App from "./App";
import { CONFIG } from "./data/config";
import "./styles.css";
import "./timeline/counters.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

render(
  () => (
    <Router base={CONFIG.base}>
      <Route path="/" component={App} />
      <Route path="/analysis" component={() => <Navigate href="/?view=analysis" />} />
    </Router>
  ),
  root,
);
