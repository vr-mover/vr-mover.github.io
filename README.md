# VR Mover - ACM UIST 2025

Official website for the paper "Can You Move These Over There? Exploring an LLM-based VR Mover to Support Natural Multi-object Manipulation" accepted at ACM UIST 2025.

## 📖 About VR Mover

VR Mover is an innovative LLM-based multimodal interface that enables natural object manipulation in virtual reality environments. By combining speech recognition, gestural cues, and user perception data, the system allows users to manipulate virtual objects through intuitive voice commands and pointing gestures.

### Key Features

- **Natural Language Interaction**: Users can say commands like "move the chair here" while pointing
- **Multimodal Input**: Combines speech, head motion, and controller gestures
- **Real-time Response**: Achieves 2.29-second average response time using atomized API calls
- **User-Centric Design**: Understands instructions from the user's perspective using focus frames
- **Intuitive Interface**: No need for structured input or complex menus

## 🎯 Research Objectives

This work addresses the challenge of creating LLM-based interfaces suitable for real-time object manipulation in VR. Unlike previous approaches that suffered from long response times (15+ seconds), VR Mover provides:

- **Real-time Performance**: Sub-3 second response times for object manipulation
- **Natural Interaction**: Support for unstructured voice and gesture commands
- **Multi-object Support**: Ability to manipulate multiple objects simultaneously
- **User Perspective Understanding**: Incorporates user's visual focus and spatial context

## 🔬 Technical Approach

VR Mover consists of four key components:

1. **Scene Modeling**: Converts 3D spatial information into text-based JSON format
2. **User-Centric Augmentation**: Processes speech, focus frames, and gestural cues
3. **LLM Processing**: Generates atomic API calls using GPT-4o for real-time response
4. **Scene Update**: Parses and executes manipulation commands asynchronously

## 📊 Performance Results

- **Response Time**: 2.29 seconds average (GPT-4o)
- **Error Rate**: <2% across multiple LLM models
- **User Satisfaction**: High preference for natural interface over traditional methods
- **Workload Reduction**: Significantly reduced arm fatigue and cognitive load

## 🌐 Website Features

This website showcases the VR Mover project with:

- **Modern Design**: Clean, professional interface with smooth animations
- **Dark/Light Theme**: Automatic theme detection with manual toggle
- **Responsive Layout**: Optimized for desktop, tablet, and mobile devices
- **Interactive Elements**: Image expander, theme toggle, and smooth transitions
- **Accessibility**: WCAG compliant with keyboard navigation support

## 📚 Paper Information

- **Conference**: ACM Symposium on User Interface Software and Technology (UIST) 2025
- **Authors**: Xiangzhi Eric Wang, Zackary P. T. Sin, Ye Jia, Daniel Archer, Wynonna H. Y. Fong, Qing Li, Chen Li
- **Institutions**: The Hong Kong Polytechnic University, University College London, Heep Yunn School
- **DOI**: Coming Soon

## 🎥 Media

- **Video Demo**: Available on YouTube
- **Paper**: Coming Soon
- **Code**: Coming Soon
- **ACM Digital Library**: Coming Soon

## 📄 License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE.md](LICENSE.md) file for details.

## 🤝 Contact

For questions about the research or technical details, please contact the research team.

---

**Note**: This website serves as the official landing page for the VR Mover project. Content will be updated as conference materials become available.
