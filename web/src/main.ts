import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { store } from "./lib/store.svelte.ts";

store.start();
mount(App, { target: document.getElementById("app")! });
