<p align="center"><img src="resources/icons/icon-256.png" width="88" alt="LLM Bench icon"></p>

<h1 align="center">LLM Bench</h1>

<p align="center"><b>How fast does your NVIDIA graphics card run AI models?</b><br>
Benchmark local LLMs on your own PC, find the best settings, and get the answer in plain words.</p>

<p align="center">
  <a href="https://github.com/nemmusu/llm-bench/releases/latest"><img src="https://img.shields.io/badge/download-latest%20release-6E56CF?style=for-the-badge" alt="Download the latest release"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white" alt="Windows 10 and 11">
  <img src="https://img.shields.io/badge/Linux-.deb%20%7C%20AppImage-FCC624?logo=linux&logoColor=black" alt="Linux: .deb and AppImage">
  <img src="https://img.shields.io/badge/NVIDIA-GPU-76B900?logo=nvidia&logoColor=white" alt="NVIDIA graphics cards">
  <img src="https://img.shields.io/badge/engines-llama.cpp%20%7C%20vLLM%20%7C%20SGLang%20%7C%20TensorRT--LLM%20%7C%20NInfer-555" alt="Engines: llama.cpp, vLLM, SGLang, TensorRT-LLM, NInfer">
  <img src="https://img.shields.io/badge/language-English%20%7C%20Italiano-555" alt="English and Italian">
</p>

<p align="center">English · <a href="README.it.md">Italiano</a> · <a href="docs/GUIDE.md">Full guide</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/benchmark-dark.png">
  <img src="docs/screenshots/en/benchmark.png" alt="LLM Bench's Benchmark page: engine, model and test length already chosen, the live graphics card readings and the latest results">
</picture>

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>⚡ Watch it run</h3>
      Tokens per second while the model writes and reads, video memory, temperature and power, live.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/test-running-dark.png"><img src="docs/screenshots/en/test-running.png" alt="A test in progress with live speed, video memory and power"></picture>
    </td>
    <td width="50%" valign="top">
      <h3>🎯 Best settings, found for you</h3>
      The largest context that fits your card, and the fastest configuration with that context full.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/tune-ranking-dark.png"><img src="docs/screenshots/en/tune-ranking.png" alt="The ranking of the configurations, each measured at its largest context"></picture>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📦 Models that fit your card</h3>
      Search Hugging Face and download the right version: LLM Bench tells you before downloading whether it fits.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/model-versions-dark.png"><img src="docs/screenshots/en/model-versions.png" alt="The versions of a model with their size and whether each one fits the graphics card"></picture>
    </td>
    <td width="50%" valign="top">
      <h3>⚖️ Compare side by side</h3>
      Up to four tests or models, always at the same context length, with the winner said in words.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/compare-dark.png"><img src="docs/screenshots/en/compare.png" alt="Four models compared: who writes and reads fastest"></picture>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔌 A local server in one click</h3>
      An OpenAI-compatible endpoint for your chats, editors and assistants, running even with the window closed.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/server-dark.png"><img src="docs/screenshots/en/server.png" alt="A running server with its OpenAI-compatible address and an example request"></picture>
    </td>
    <td width="50%" valign="top">
      <h3>💬 Results in plain words</h3>
      A score, a sentence that explains it, and a <b>?</b> next to every number. No jargon needed.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/result-dark.png"><img src="docs/screenshots/en/result.png" alt="A result: the score, the speed explained in words and the main numbers"></picture>
    </td>
  </tr>
</table>

Works with **llama.cpp**, **vLLM**, **SGLang**, **TensorRT-LLM**, **NInfer** and their forks: LLM Bench installs and updates them with a button, and always asks before downloading anything.

## Download

Get the file for your system from the **[latest release](https://github.com/nemmusu/llm-bench/releases/latest)**:

| System | File |
|---|---|
| Windows 10 / 11 | `LLM-Bench-Setup-x.y.z.exe` (installer) or `LLM-Bench-x.y.z-portable.exe` |
| Ubuntu, Debian | `llm-bench-x.y.z-amd64.deb` |
| Other Linux | the `.AppImage` |

You only need an NVIDIA graphics card with its driver. Some engines also use Docker or WSL 2: LLM Bench tells you when and helps you set them up.

## Get started in 3 steps

1. **Open LLM Bench.** It checks your PC and suggests an engine, a model that fits and a quick test.
2. **Press "Start benchmark".**
3. **Read the result.** Then try **Find the best settings** for your favourite model.

## Learn more

- 📖 **[Full guide](docs/GUIDE.md)**: install, every screen, engines, troubleshooting · [Italiano](docs/GUIDA.md)
- 🛠️ **[For developers](docs/DEVELOPMENT.md)**: build, tests, architecture
